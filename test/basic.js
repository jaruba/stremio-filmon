var tape = require("tape");
var _ = require("lodash");

var Stremio = require("stremio-addons");

var server = require("../filmon");

var PORT = 9005;

tape("listening on port", function(t) {
	t.timeoutAfter(500);

	var server = require("../filmon").listen(PORT).on("listening", function() {
		t.ok(PORT == server.address().port, "server is listening on port")
		t.end();
	})
});



tape("meta.find", function(t) {

});


tape("meta.get single result", function(t) {

});