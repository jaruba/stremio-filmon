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
    name: pkg.displayName, version: pkg.version, description: pkg.description,
};


var pipe = new bagpipe(1);
var sid; // filmon session ID

pipe.push(function(cb) {
    filmon("init", { app_id: FILMON_KEY, app_secret: FILMON_SECRET }, function(err, resp) {
        console.log(resp);
        sid = resp.session_key;
        // TODO: we can also get featured channels, etc.
        // TODO: detect no sid, etc.
        pipe.limit = FILMON_LIMIT;
    })
});

function filmon(path, args, callback) {
    needle.post(FILMON_BASE+"/"+path, args, { json: true }, function(err, resp, body) {
        // TODO: refine err handling
        callback(err, body);
    });
}

pipe.push

function getStream(args, callback) {

}

var addon = new Stremio.Server({
    "stream.get": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? (resp[0] || null) : undefined) })
    },
    "stream.find": function(args, callback, user) {
        pipe.push(getStream, args, function(err, resp) { callback(err, resp ? resp.slice(0,4) : undefined) }); 
    }
}, { /* secret: mySecret */ }, manifest);

var server = require("http").createServer(function (req, res) {
    addon.middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
}).on("listening", function()
{
    console.log("Filmon Stremio Addon listening on "+server.address().port);
}).listen(process.env.PORT || 9005);
