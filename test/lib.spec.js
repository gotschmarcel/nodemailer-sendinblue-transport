var assert = require("assert");
var fs = require("fs");
var nodemailer = require("nodemailer");
var sendinblue = require("../lib/nodemailer-sendinblue-transport");
var rewiremock = require("rewiremock/node");
var stream = require('stream')


function MockTransport(sb) {
    assert(sb);
    this.sb = sb;
}

MockTransport.prototype.send = function (mail, cb) {
    this.sb.buildBody(mail).then(function (body) {
        cb(undefined, body);
    }).catch(cb);
};

MockTransport.prototype.reset = function () {
    this.data = undefined;
};

var mock = new MockTransport(sendinblue({
    apiKey: "dummy",
    apiUrl: "dummy"
}));
var transport = nodemailer.createTransport(mock);


describe("SendinBlueTransport", function () {
    describe("#buildBody", function () {
        it("should parse plain 'from' address", function (done) {
            transport.sendMail({
                from: "example@test.net"
            }, function (err, body) {
                assert.deepStrictEqual(body.from, ["example@test.net", ""]);
                done();
            });
        });

        it("should parse 'from' address with name", function (done) {
            transport.sendMail({
                from: "\"Doe, Jon\" <example@test.net>"
            }, function (err, body) {
                assert.deepStrictEqual(body.from, ["example@test.net", "Doe, Jon"]);
                done();
            });
        });

        it("should parse 'from' address object", function (done) {
            transport.sendMail({
                from: { name: "Doe, Jon", address: "example@test.net" }
            }, function (err, body) {
                assert.deepStrictEqual(body.from, ["example@test.net", "Doe, Jon"]);
                done();
            });
        });

        it("should parse plain 'to' address", function (done) {
            transport.sendMail({
                to: "example@test.net, example2@test.net"
            }, function (err, body) {
                assert.deepStrictEqual(body.to, {
                    "example@test.net": "",
                    "example2@test.net": ""
                });
                done();
            });
        });

        it("should parse plain or named 'to' address", function (done) {
            transport.sendMail({
                to: ["example@test.net", "\"Don, Joe\" <example2@test.net>"]
            }, function (err, body) {
                assert.deepStrictEqual(body.to, {
                    "example@test.net": "",
                    "example2@test.net": "Don, Joe"
                });
                done();
            });
        });

        it("should parse object 'to' address", function (done) {
            transport.sendMail({
                to: {address: "example@test.net", name: "Don Joe"}
            }, function (err, body) {
                assert.deepStrictEqual(body.to, {"example@test.net": "Don Joe"});
                done();
            });
        });

        it("should flatten address groups", function (done) {
            transport.sendMail({
                to: "AGroup: example@test.net, example2@test.net"
            }, function (err, body) {
                assert.deepStrictEqual(body.to, {
                    "example@test.net": "",
                    "example2@test.net": ""
                });
                done();
            });
        });

        it("should fill out all address fields", function (done) {
            transport.sendMail({
                from: "example@test.net",
                to: "example@test.net",
                cc: "example@test.net",
                bcc: "example@test.net",
                replyTo: "example@test.net"
            }, function (err, body) {
                assert.deepStrictEqual(body.from, ["example@test.net", ""]);
                assert.deepStrictEqual(body.to, {"example@test.net": ""});
                assert.deepStrictEqual(body.cc, {"example@test.net": ""});
                assert.deepStrictEqual(body.bcc, {"example@test.net": ""});
                assert.deepStrictEqual(body.replyto, ["example@test.net", ""]);
                done();
            });
        });

        it("should handle url attachements", function (done) {
            transport.sendMail({
                attachments: [{
                    path: "http://domain.do/file.suffix"
                }]
            }, function (err, body) {
                assert.deepStrictEqual(body.attachment, ["http://domain.do/file.suffix"]);
                done();
            });
        });

        it("should handle url with a filename attachements", function (done) {
            const http = rewiremock.proxy('http', {});
            async function * generate() {
                yield Buffer.from('some');
                yield Buffer('attachment');
                yield Buffer('string');
            }
            http.get = function(url, callback){
                const response = stream.Readable.from(generate())
                callback(response)
                return Promise.resolve(response)
            }
            transport.sendMail({
                attachments: [{
                    href: "http://domain.do/file.suffix",
                    filename: 'test'
                }]
            }, function (err, body) {
                if(err) console.error(err)
                assert.deepStrictEqual(body.attachment, { test: Buffer.from('someattachmentstring').toString("base64") });
                done();
            });
        });

        it("should handle generated plain content attachements", function (done) {
            transport.sendMail({
                attachments: [{
                    filename: "a",
                    content: "Hello World"
                }]
            }, function (err, body) {
                assert.deepStrictEqual(body.attachment, {
                    "a": "SGVsbG8gV29ybGQ="
                });
                done();
            });
        });

        it("should handle generated plain content attachements with encoding", function (done) {
            transport.sendMail({
                attachments: [{
                    filename: "a",
                    content: "\xff\xfa\xc3\x4e",
                    encoding: "binary"
                }]
            }, function (err, body) {
                assert.deepStrictEqual(body.attachment, {
                    "a": "//rDTg=="
                });
                done();
            });
        });

        it("should handle generated Buffer attachements", function (done) {
            transport.sendMail({
                attachments: [{
                    filename: "a",
                    content: new Buffer("Hello World")
                }]
            }, function (err, body) {
                assert.deepStrictEqual(body.attachment, {
                    "a": "SGVsbG8gV29ybGQ="
                });
                done();
            });
        });

        it("should handle generated Readable attachements", function (done) {
            var testFile = __dirname + "/lib.spec.js";

            transport.sendMail({
                attachments: [{
                    filename: "a",
                    content: fs.createReadStream(testFile)
                }]
            }, function (err, body) {
                assert.deepStrictEqual(body.attachment, {
                    "a": fs.readFileSync(testFile).toString("base64")
                });
                done();
            });
        });

        it("should handle generated file attachements", function (done) {
            var testFile = __dirname + "/lib.spec.js";

            transport.sendMail({
                attachments: [{
                    filename: "a",
                    path: testFile
                }]
            }, function (err, body) {
                assert.deepStrictEqual(body.attachment, {
                    "a": fs.readFileSync(testFile).toString("base64")
                });
                done();
            });
        });
    });
});
