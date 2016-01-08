var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");
var bagpipe = require("bagpipe");
var sift = require("sift");

var stremioCentral = "http://api8.herokuapp.com";
//var mySecret = "your secret"; 

var FILMON_KEY = "foo";
var FILMON_SECRET = "bar";
var FILMON_BASE = "http://www.filmon.com/tv/api";
var FILMON_LIMIT = 5; // concurrency limit

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.filmon",
    "types": ["tv"],
    "filter": { "query.filmon_id": { "$exists": true }, "query.type": { "$in":["tv"] } },
    posterShape: { tv: "square" }, 
    repository: "http://github.com/Ivshti/stremio-filmon",
    endpoint: "http://filmon.strem.io/stremioget",
    name: pkg.displayName, version: pkg.version, description: pkg.description,
    sorts: [{prop: "popularities.filmon", name: "Filmon.tv",types:["tv"]}]
};


var pipe = new bagpipe(1);
var sid; // filmon session ID
var channels = { }; // all data about filmon.tv channels we have; store in memory for faster response, update periodically
// { featured: ..., groups: ..., all: ... }
var initInPrg = false;

pipe.push(filmonInit);
pipe.push(filmonChannels);
pipe.push(filmonGroups);

function filmon(path, args, callback) {
    if (path != "init" && !sid && !initInPrg) { pipe.limit = 1; return pipe.push(filmonInit, function() { pipe.limit = FILMON_LIMIT; filmon(path, args, callback) }); }

    var cb = function(err, resp, body) {
        // TODO: refine err handling
        if (typeof(body) != "object") return callback(new Error("wrong response type returned "+body));
        callback(err, body);
    };
    if (args === null) needle.get(FILMON_BASE+"/"+path, { json: true, read_timeout: 3000, open_timeout: 3000 }, cb);
    else needle.post(FILMON_BASE+"/"+path, _.extend({ session_key: sid }, args), { json: true, read_timeout: 3000, open_timeout: 3000, }, cb);
}

// Get session ID and featured channels
function filmonInit(cb) {
    initInPrg = true;
    filmon("init", { app_id: FILMON_KEY, app_secret: FILMON_SECRET }, function(err, resp) {
        initInPrg = false;

        if (err) console.error(err);
        if (! (resp && resp.session_key)) {
		console.error("filmon-init: no proper session key",resp); 
		return cb();
        }

        sid = resp.session_key;
	    setTimeout(function() { sid = null }, 2*60*60*1000);
        channels.featured = resp.featured_channels;
	
        cb();
    })
}

// Get all groups of channels
function filmonGroups(cb) {
    filmon("groups", { }, function(err, resp) {
        if (! resp) return cb(); // TODO: handle the error
        channels.groups = _.indexBy(resp, "group");
        cb();
    });
    setTimeout(function() { pipe.push(filmonGroups) }, 24*60*60*1000);
}

// Get all channels
function filmonChannels(cb) {
    filmon("channels", { }, function(err, resp) {
        if (err) console.error(err);
        if (! resp) return cb(); // TODO: handle the error

        channels.all = _.chain(resp).map(function(x) {
            var idx = channels.featured.channels.indexOf(x.id);
            var pop = idx != -1 ? (channels.featured.channels.length + 1 - idx) : 0;
            return {
                filmon_id: x.id,
                name: x.title,
                poster: x.big_logo || x.logo,
                //logo: x.big_logo || x.logo, 
                posterShape: "square", backgroundShape: "contain", logoShape: "hidden",
                banner: x.extra_big_logo || x.big_logo,
                genre: [ x.group && x.group.toLowerCase().replace(/(?:^|\s)\S/g, function(a) { return a.toUpperCase() }) ],
                isFree: parseInt(x.is_free) || parseInt(x.is_free_sd_mode),
                popularity: pop, // hehe
                popularities: {filmon: pop},
                type: "tv"
                //certification: x.content_rating,
                // is_free, is_free_sd_mode, type, has_tvguide, seekable,  upnp_enabled
            };
        })
        .filter(function(channel) {
            if (channel.genre[0] && channel.genre[0].match(/filmon/i)) return false;
            if (!channel.isFree) return false; 
            return true; 
        })
        .indexBy("filmon_id").value();

        channels.values = _.chain(channels.all).values()
            .sortBy(function(x) { return -x.popularity })
            .value();

        cb();
        pipe.limit = FILMON_LIMIT;
    });
    setTimeout(function() { pipe.push(filmonChannels) }, 12*60*60*1000);
}

function getStream(args, callback) {
    callback = _.once(callback);

    if (! args.query) return callback(new Error("query must be supplied"));
    if (! args.query.filmon_id) return callback(new Error("no filmon_id"));
    filmon("channel/"+args.query.filmon_id, { }, function(err, resp) {
        if (err) return callback(err);
        
        var streams = _.chain(resp.streams)
        .sortBy(function(x) { return -(x["watch-timeout"] > 2*60*60) })
        .slice(0, 1) // only the first streem, no need for more
        .map(function(stream) {
            return { availability: 2, url: stream.url, tag: [stream.quality, "hls"], timeout: stream["watch-timeout"], filmon_sid: sid, filmon_id: args.query.filmon_id } 
        })
        .value();

        // WARNING: streams from live53.la3.edge.filmon.com (live*.la*.edge.filmon.com ?) do not work across APIs
        // the reason is the ID, it matters on which IP it was aquired 
        //console.log(streams.map(function(x) { return x.url }));

        callback(null, streams);
    });

    setTimeout(function() { callback(null) }, 10000);
}

var QUERY_PROPS = ["genre", "filmon_id", "name", "type"]; // TODO: other properties?
function getMeta(args, callback) {
    //console.log(args)
    if (! channels.all) return callback(new Error("internal error - no channels data"));

    var proj, projFn;
    if (args.projection && typeof(args.projection) == "object") { 
        proj = _.keys(args.projection);
        projFn = _.values(args.projection)[0] ? _.pick : _.omit;
    }

    callback(null, _.chain(channels.values)
        .filter(args.query ? sift(args.query) : _.constant(true))
        .slice(args.skip || 0, Math.min(400, args.limit))
        .map(function(x) { return projFn ? projFn(x, proj) : x })
        .value());
}


var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? (resp[0] || null) : undefined) })
    },
    "stream.find": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? resp.slice(0, 4) : undefined) }); 
    },
    "meta.get": function(args, callback, user) {
        // No point, we store them in string
        //if (args.query && args.query.filmon_id) args.query.filmon_id = parseInt(args.query.filmon_id);

        pipe.push(getMeta, _.extend(args, { limit: 1 }), function(err, res) { 
            if (err) return callback(err);

            res = res ? res[0] : null;
            if (! res) return callback(null, null);

            if (args.projection && args.projection != "full") return callback(null, res);

            filmon("tvguide/"+res.filmon_id, null, function(err, resp) {
                if (err) console.error(err);

                // WARNING: this object is huge
                res.tvguide = resp;
                callback(null, res);
            });
        });
    },
    "meta.find": function(args, callback, user) {
        pipe.push(getMeta, args, callback); // push to pipe so we wait for channels to be crawled
    },
    /*
    "meta.search": function(args, callback, user) {
        console.log("meta.search - figure out a FTS index");
        // init an FTS somehow?
    }
    */
}, { stremioget: true, allow: ["http://api8.herokuapp.com","http://api9.strem.io"] /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Filmon Stremio Addon listening on "+server.address().port);
})
if (module.parent) module.exports = server;
else server.listen(process.env.PORT || 9005);
