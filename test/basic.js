var tape = require("tape");
var _ = require("lodash");

var Stremio = require("stremio-addons");

var server = require("../filmon");

var PORT = 9005;
var someChannel;

tape("listening on port", function(t) {
	t.timeoutAfter(500);
	var server = require("http").createServer(function (req, res) {
		require("../filmon").middleware(req, res, function() { res.end() }); // wire the middleware - also compatible with connect / express
	});
	server.listen(PORT).on("listening", function() {
		t.ok(PORT == server.address().port, "server is listening on port")
		t.end();
	})
});

tape("initializes properly", function(t) {
	t.timeoutAfter(1000);

	addon = new Stremio.Client();
	addon.add("http://localhost:"+PORT);
	addon.on("addon-ready", function(service) {
		t.ok(service.manifest, "has manifest");
		t.ok(service.manifest.name, "has name");
		t.ok(service.manifest.methods && service.manifest.methods.length, "has methods");
		t.ok(service.manifest.methods && service.manifest.methods.indexOf("stream.find")!=-1, "has stream.find method");
		t.ok(service.manifest.methods && service.manifest.methods.indexOf("meta.find")!=-1, "has meta.find method");
		t.ok(service.manifest.methods && service.manifest.methods.indexOf("meta.get")!=-1, "has meta.get method");
		t.end();
	});
});


tape("meta.find", function(t) {
	addon.meta.find({ query: {}, sort: { popularity: -1 }, limit: 5 }, function(err, res) {
		t.notOk(err, "has error");
		t.ok(res, "has res object");
		t.ok(res.length, "has results");
		t.ok(res.length == 5, "results are limited to 5");
		
		someChannel = res[0];

		t.ok(someChannel.poster, "has poster");
		t.ok(someChannel.name, "has name");
		t.ok(someChannel.popularity, "has popularity");
		t.equal(someChannel.type, "tv", "type is tv");
		t.equal(someChannel.posterShape, "square", "poster shape is square");

		t.end();
	});
});


tape("meta.get single result", function(t) {
	addon.meta.get({ query: { filmon_id: someChannel.filmon_id } }, function(err, res) {
		t.notOk(err, "has error");
		t.equal(res.filmon_id, someChannel.filmon_id, "id matches");

		t.ok(res.poster, "has poster");
		t.ok(res.banner, "has banner");
		t.ok(res.name, "has name");
		t.ok(res.popularity, "has popularity");

		t.ok(res.tvguide, "has tvguide");
		t.ok(Array.isArray(res.tvguide), "tvguide is array");

		t.end();
	});
});



tape("stream.find", function(t) {
	addon.stream.find({ query: { filmon_id: someChannel.filmon_id } }, function(err, res) {
		t.notOk(err, "has error");

		t.ok(res, "has res object");
		t.ok(res.length, "has results");

		t.ok(res[0].url, "has url for first result");
		t.ok(res[0].availability, "has availability for first result");

		t.end();
	});
});