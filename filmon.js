var Stremio = require("stremio-addons");
var needle = require("needle");
var _ = require("lodash");
var bagpipe = require("bagpipe");

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

function filmonInit(cb) {
    filmon("init", { app_id: FILMON_KEY, app_secret: FILMON_SECRET }, function(err, resp) {
        if (err) console.error(err);
        if (! (resp && resp.session_key)) return cb(); // TODO: handle the error
        
        sid = resp.session_key;
        channels.featured = resp.featured_channels;

        pipe.push(filmonChannels);
        pipe.push(filmonGroups);

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
        channels.all = _.indexBy(resp, "id");
        pipe.limit = FILMON_LIMIT;
        cb();
    });
    setTimeout(function() { pipe.push(filmonChannels) }, 12*60*60*1000);
}

function getStream(args, callback) {

}

function getMeta(args, callback) {
    // respect: query.type (must be tv)
    // query.genre
    // query.filmon_id !!
    // query.name
    // projection
    // limit
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
    },
    "meta.find": function(args, callback, user) {
        console.log("meta.find - just return results from channels.all");
        console.log(args)
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
