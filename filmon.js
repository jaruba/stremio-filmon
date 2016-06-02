var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");
var bagpipe = require("bagpipe");
var sift = require("sift");

var LinvoFTS = require("linvodb-fts");

var stremioCentral = "http://api9.strem.io";
//var mySecret = "your secret"; 

var FILMON_KEY = "foo";
var FILMON_SECRET = "bar";
var FILMON_BASE = "http://www.filmon.com/tv/api";
var FILMON_LIMIT = 12; // concurrency limit

var FILMON_STREMIO_FEATURED = [
   // ids of featured TV channels in stremio
];

var HOUR = 60*60*1000;

var pkg = require("./package");
var manifest = { 
    "id": "org.stremio.filmon",
    "types": ["tv"],
    "filter": { "query.filmon_id": { "$exists": true }, "query.type": { "$in":["tv"] } },
    icon: "http://www.strem.io/images/icon-filmon-addon.png",
    logo: "http://www.strem.io/images/addons/filmon-logo.png",
    repository: "http://github.com/Stremio/stremio-filmon",
    endpoint: "http://filmon.strem.io/stremioget/stremio/v1",
    name: pkg.displayName, version: pkg.version, description: pkg.description,
    isFree: true,
    sorts: [{prop: "popularities.filmon", name: "Filmon.tv",types:["tv"]}]
};

// Cache
var cacheSet, cacheGet, red;
if (process.env.REDIS) {
    // In redis
    console.log("Using redis caching");

    var redis = require("redis");
    red = redis.createClient(process.env.REDIS);
    red.on("error", function(err) { console.error("redis err",err) });

    cacheGet = function (domain, key, cb) { 
        red.get(domain+":"+key, function(err, res) { 
            if (err) return cb(err);
            if (process.env.CACHING_LOG) console.log("cache on "+domain+":"+key+": "+(res ? "HIT" : "MISS"));
            if (!res) return cb(null, null);
            try { cb(null, JSON.parse(res)) } catch(e) { cb(e) }
        }); 
    };
    cacheSet = function (domain, key, value, ttl) {
        if (ttl) red.setex(domain+":"+key, ttl/1000, JSON.stringify(value), function(e){ if (e) console.error(e) });
        else red.set(domain+":"+key, JSON.stringify(value), function(e) { if (e) console.error(e) });
    }
} else {
    // In memory
    var cache = {};
    cacheGet = function (domain, key, cb) { cb(null, cache[domain+":"+key]) }
    cacheSet = function(domain, key, value, ttl) 
    {
        cache[domain+":"+key] = value;
        if (ttl) setTimeout(function() { delete cache[domain+":"+key] }, ttl);
    }
}

// Filmon runtime things
var pipe = new bagpipe(1);
var sid; // filmon session ID
var channels = { }; // all data about filmon.tv channels we have; store in memory for faster response, update periodically
// { featured: ..., groups: ..., all: ... }
var initInPrg = false;
var search = new LinvoFTS();

pipe.push(filmonInit);
pipe.push(filmonChannels);
pipe.push(filmonGroups);

// Filmon API
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

function filmonCached(ttl, path, args, callback) {
    cacheGet("filmon", path, function(err, body) {
        if (body) return callback(null, body);

        filmon(path, args, function(err, res) {
            if (res) cacheSet("filmon", path, res, ttl);
            callback(err, res);
        });
    });
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
    setTimeout(function() { pipe.push(filmonGroups) }, 24*HOUR);
}

// Get all channels
function filmonChannels(cb) {
    filmonCached(6*60*60*1000, "channels", { }, function(err, resp) {
        if (err) console.error(err);
        if (! resp) return cb(); // TODO: handle the error

        channels.all = _.chain(resp).map(function(x) {
            var idx = channels.featured.channels.indexOf(x.id);
            var pop = idx != -1 ? (channels.featured.channels.length + 1 - idx)+1 : 1;

            return {
                id: "filmon_id:"+x.id,
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
                // Interesting stuff:
                // is_free, is_free_sd_mode, type, has_tvguide, seekable, is360, upnp_enabled
            };
        })
        .filter(function(channel) {
            if (channel.genre[0] && channel.genre[0].match(/filmon/i)) return false;
            if (!channel.isFree) return false; 

            search.add(channel.filmon_id, search.get(channel, {
                name: { /*title: true, */ bigram: true, trigram: false, metaphone: false, boost: 2 }, // title is false to get rid of stopwords
            }));

            return true;
        })
        .indexBy("filmon_id").value();

        channels.values = _.chain(channels.all).values()
            .sortBy(function(x) { return -x.popularity })
            .value();

        pipe.limit = FILMON_LIMIT;

        channels.values.forEach(function(channel) {
            if (channel.popularity <= 1) return;
            pipe.push(filmonCached, 12*HOUR, "tvguide/"+channel.filmon_id, null, function(err, resp) {
                if (err) console.error(err);
                channel.tvguide = resp && resp.map(mapTvGuide);
            });
        });

        cb();
    });
    setTimeout(function() { pipe.push(filmonChannels) }, 12*HOUR);
}

function getStream(args, callback) {
    callback = _.once(callback);
    setTimeout(function() { callback(new Error("internal getStream timeout")) }, 10000);

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
}

var QUERY_PROPS = ["genre", "filmon_id", "name", "type"]; // TODO: other properties?
function getMeta(args, callback) {
    callback = _.once(callback);
    setTimeout(function() { callback(new Error("internal getMeta timeout")) }, 10000);

    //console.log(args)
    if (! channels.all) return callback(new Error("internal error - no channels data"));

    var proj, projFn;
    if (args.projection && typeof(args.projection) == "object") { 
        proj = _.keys(args.projection);
        projFn = _.values(args.projection)[0] ? _.pick : _.omit;
    } else {
        proj = ['tvguide'];
        projFn = _.omit;
    }

    var res = _.chain(channels.values)
        .filter(args.query ? sift(args.query) : _.constant(true))
        .slice(args.skip || 0, (args.skip || 0) + Math.min(400, args.limit || 70))
        .value();

    (function(next) {
        if (res.length === 1 && !res[0].tvguide) filmonCached(12*HOUR, "tvguide/"+res[0].filmon_id, null, function(err, resp) {
            if (err) console.error(err);

            // WARNING: this object is huge
            res[0].tvguide = Array.isArray(resp) && resp.map(mapTvGuide);
            next();
        }); else next();
    })(function() {
        res = res.map(function(x) { 
            var projected = projFn(x, proj);
            projected.tvguide_short = x.tvguide && x.tvguide.filter(function(x) {
                return Math.abs( Date.now() - (new Date(x.starts).getTime() + 1*HOUR) ) < 6*HOUR;
            }).map(function(x) {
                return _.pick(x, "starts", "ends", "name")
            });
            return projected;
        });

        callback(null, res);
    });
}

function mapTvGuide(x) {
    return { 
        name: x.programme_name,
        category: x.programme_category,
        description: x.programme_description,
        starts: new Date(x.startdatetime * 1000).getTime(),
        ends: new Date(x.enddatetime * 1000).getTime(),
        id: x.programme,
        season: x.seriesNumber, episode: x.episodeNumber, seriesId: x.seriesId,
        provider: x.provider,
       // images: x.images // super heavy, pointless for now
    }
}


var addon = new Stremio.Server({
    "stream.find": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? resp.slice(0, 4) : undefined) }); 
    },
    "meta.get": function(args, callback, user) {
        // No point, we store them in string
        //if (args.query && args.query.filmon_id) args.query.filmon_id = parseInt(args.query.filmon_id);
        args.projection = args.projection || { }; // full
        pipe.push(getMeta, _.extend(args, { limit: 1 }), function(err, res) { 
            if (err) return callback(err);

            res = res && res[0];
            if (! res) return callback(null, null);

            callback(null, res);
        });
    },
    "meta.find": function(args, callback, user) {
        pipe.push(getMeta, args, callback); // push to pipe so we wait for channels to be crawled
    },
    "meta.search": function(args, callback, user) {
        if (typeof(args.query) != "string") return callback({ code: 2000, message: "no string query" });
        if (args.query.length < 3) return callback(null, []);
        search.query(args.query, function(err, res) {
            if (err) { console.error(err); return callback({ code: 2001, message: "search err" }); }

            if (!res.length) return callback(null, { query: args.query, results: [] });

            // Filter results which make sense (always allow first 2)
            var max = res[0].score;
            res = res.filter(function(x, i) { return (x.score > max/2) || i<2 }); 
            callback(null, { query: args.query, results: res.map(function(x) { return channels.all[x.id] }).slice(0,6) });
        });
    }
}, { stremioget: true, cacheTTL: { "meta.find": 30*60, "stream.find": 30*60, "meta.get": 4*60*60 }, allow: ["http://api8.herokuapp.com","http://api9.strem.io"] /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Filmon Stremio Addon listening on "+server.address().port);
})
if (module.parent) module.exports = server;
else server.listen(process.env.PORT || 9005);

var catchMyExceptions = require('catch-my-exceptions');
if (process.env.SLACK_HOOK) catchMyExceptions(process.env.SLACK_HOOK, { slackUsername: "filmon" });
