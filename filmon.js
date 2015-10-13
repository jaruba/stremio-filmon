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
var FILMON_LIMIT = 3; // concurrency limit

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.filmon",
    "types": ["tv"],
    "filter": { "query.filmon_id": { "$exists": true }, "query.type": { "$in":["tv"] } },
    posterShape: { tv: "square" }, 
    name: pkg.displayName, version: pkg.version, description: pkg.description,
};


var pipe = new bagpipe(1);
var sid; // filmon session ID
var channels = { }; // all data about filmon.tv channels we have; store in memory for faster response, update periodically
// { featured: ..., groups: ..., all: ... }

pipe.push(filmonInit);

function filmon(path, args, callback) {
    needle.post(FILMON_BASE+"/"+path, _.extend({ session_key: sid }, args), { json: true }, function(err, resp, body) {
        // TODO: refine err handling
        callback(err, body);
    });
}

function filmonInit(cb) {
    filmon("init", { app_id: FILMON_KEY, app_secret: FILMON_SECRET }, function(err, resp) {
        if (err) console.error(err);
        if (! (resp && resp.session_key)) return cb(); // TODO: handle the error
        
        sid = resp.session_key;
        channels.featured = resp.featured_channels;
        pipe.limit = FILMON_LIMIT;

        pipe.push(filmonGroups);
        pipe.push(filmonChannels);

        cb();
    })
}

function filmonGroups(cb) {
    filmon("groups", { }, function(err, resp) {
        if (! resp) return cb(); // TODO: handle the error
        channels.groups = _.indexBy(resp, "group");
        cb();
    });
    setTimeout(function() { pipe.push(filmonGroups) }, 24*60*60*1000);
}
function filmonChannels(cb) {
    filmon("channels", { }, function(err, resp) {
        if (! resp) return cb(); // TODO: handle the error
        
        channels.all = _.chain(resp).map(function(x) {
            var idx = channels.featured.channels.indexOf(x.id);
            console.log(idx != -1 ? (channels.featured.channels.length + 1 - idx) : 0)
            return {
                filmon_id: x.id,
                name: x.title,
                poster: x.big_logo || x.logo,
                posterShape: "square",
                //banner: x.extra_big_logo || x.big_logo,
                genre: [ x.group.toLowerCase().replace(/(?:^|\s)\S/g, function(a) { return a.toUpperCase() }) ],
                isFree: parseInt(x.is_free) || parseInt(x.is_free_sd_mode),
                popularity: idx != -1 ? (channels.featured.channels.length + 1 - idx) : 0, // hehe
                type: "tv"
                //certification: x.content_rating,
                // is_free, is_free_sd_mode, type, has_tvguide, seekable,  upnp_enabled
            };
        })
        .filter(function(channel) {
            if (channel.genre[0].match("filmon")) return false;
            if (!channel.isFree) return false; 
            return true; 
        })
        .indexBy("filmon_id").value();

        channels.values = _.chain(channels.all).values()
            .sortBy(function(x) { return -x.popularity })
            .value();

        pipe.limit = FILMON_LIMIT;
        cb();
    });
    setTimeout(function() { pipe.push(filmonChannels) }, 12*60*60*1000);
}

function getStream(args, callback) {

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
    // TODO: string projections - lean, medium and full 
    // full should get a tvguide

    callback(null, _.chain(channels.values)
        .filter(args.query ? sift(args.query) : _.constant(true))
        .slice(args.skip || 0, Math.min(400, args.limit))
        .map(function(x) { return projFn ? projFn(x, proj) : x })
        .value());
}


var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        console.log("stream.get - get the channel, return hls as URL");
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? (resp[0] || null) : undefined) })
    },
    "stream.find": function(args, callback, user) {
        console.log("stream.find - just say anything in .all is available");
        // TODO: just reply that everything is available 
    },
    "meta.get": function(args, callback, user) {
        console.log("meta.get - return stuff from channels.all, consider supplementing with filmon('tvguide')");
        pipe.push(getMeta, _.extend(args, { limit: 1 }), function(err, res) { 
            if (err) return callback(err);

            res = res ? res[0] : null;
            if (! res) return callback(null, null);

            // TODO: tvguide
            callback(null, res);
        });
    },
    "meta.find": function(args, callback, user) {
        pipe.push(getMeta, args, callback); // push to pipe so we wait for channels to be crawled
    },
    "meta.search": function(args, callback, user) {
        console.log("meta.search - figure out a FTS index");
        // init an FTS somehow?
    }
}, { /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Filmon Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);
