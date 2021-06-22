var fs            = require("fs");
var stream        = require("stream");
var util          = require("util");
var http          = require("http");
var https         = require("https");
var url           = require("url");
var addressparser = require("addressparser");
var Promise       = require("promise");
var pkg           = require("../package.json");

//
// Constants
//
var STATUS_OK = 200;

//
// Helper
//
function isUndefined(v) {
    return typeof v === "undefined";
}

function isString(v) {
    return typeof v === "string" || v instanceof String;
}

function isObject(v) {
    return !isUndefined(v) && v.toString() === "[object Object]";
}

function isArray(v) {
    return v instanceof Array;
}

function isEmpty(v) {
    return !(v.length || Object.keys(v).length);
}

function prefixedErr(err, prefix) {
    err.message = [prefix, err.message].join(": ");
    return err;
}

function addAddress(obj, address) {
    obj[address.address] = address.name || "";
    return obj;
}

function flattenGroups(addresses) {
    var flattened = [];

    function traverse(obj) {
        if (obj.group) {
            obj.group.forEach(traverse);
        } else {
            flattened.push(obj);
        }
    }

    addresses.forEach(traverse);

    return flattened;
}

function transformAddress(a) {
    if (isString(a)) {
        return addressparser(a);
    }

    if (isObject(a)) {
        return [a];
    }

    throw new Error("invalid address: " + a);
}

function transformAddresses(addresses) {
    if (!addresses) {
        return undefined;
    }

    var parsed = [];
    if (isString(addresses)) {
        parsed = addressparser(addresses);
    } else if (isArray(addresses)) {
        addresses.forEach(function (address) {
            parsed = parsed.concat(transformAddress(address));
        });
    } else if (isObject(addresses)) {
        parsed.push(addresses);
    } else {
        throw new Error("invalid address: " + addresses);
    }

    return flattenGroups(parsed).reduce(addAddress, {});
}

function transformFromAddresses(addresses) {
    if (!addresses) {
        return undefined;
    }

    var transformed = transformAddresses(addresses);
    var from = Object.keys(transformed)[0];

    return [from, transformed[from]];
}

function buildAttachment(attachment, remote, generated) {
    return new Promise(function (resolve, reject) {
        // Raw -> not supported
        if (!isUndefined(attachment.raw)) {
            return reject(new Error("raw attachments not supported"));
        }

        // Remote attachment.
        if (isString(attachment.href)) {
            if (!isEmpty(generated)) {
                return reject(new Error("mixed remote and generated attachments"));
            }

            if(!isString(attachment.filename)) {
                remote.push(attachment.href);
                return resolve();
            }
            const httpOrHttps = /^https/.test(attachment.href) ? https : http

            const data = []
            httpOrHttps.get(attachment.href, function(response) {
                response.on('data', function(chunk) {
                    data.push(chunk)
                })
                response.on('end', function(){
                    generated[attachment.filename] = Buffer.concat(data).toString("base64");
                    return resolve()
                })

                response.on('error', (err) => console.log({errorHere: err}))
            });
            return 
        }

        // Generated attachment.
        if (!isEmpty(remote)) {
            return reject(new Error("mixed remote and generated attachments"));
        }

        var filename = attachment.filename;
        if (!isString(filename)) {
            return reject(new Error("missing filename for attachment"));
        }

        // Local file.
        if (isString(attachment.path)) {
            fs.readFile(attachment.path, function (err, data) {
                if (err) {
                    return reject(err);
                }
                generated[filename] = data.toString("base64");
                resolve();
            });
            return;
        }

        var content = attachment.content;
        var encoding = attachment.encoding;

        if (isString(content)) {
            generated[filename] = encoding === "base64" ? content
                : (new Buffer(content, encoding).toString("base64"));
            return resolve();
        }

        if (Buffer.isBuffer(content)) {
            generated[filename] = content.toString("base64");
            return resolve();
        }

        if (content instanceof stream.Readable) {
            var chunks = [];
            content.on("data", function (chunk) {
                chunks.push(chunk);
            }).on("close", function () {
                generated[filename] = Buffer.concat(chunks).toString("base64");
                resolve();
            }).on("error", reject);
            return;
        }

        reject(new Error("invalid attachment format"));
    });
}

function buildAttachments(attachments) {
    var remote = [];
    var generated = {};

    var promises = attachments.map(function (attachment) {
        return buildAttachment(attachment, remote, generated);
    });

    return Promise.all(promises).then(function () {
        if (remote.length > 0) {
            return remote;
        }

        return generated;
    });
}

function isErrorResponse(response) {
    if (response.statusCode !== STATUS_OK) {
        return true;
    }

    return false;
}

function responseError(response, body) {
    return new Error(
        util.format("%s (%s, %d)",
            body.message || "server error",
            body.code || "-",
            response.statusCode));
}

function makeInfo(body) {
    return {
        messageId: body.data["message-id"] || "",
        code: body.code,
        message: body.message
    };
}

//
// Transport class
//
function SendinBlueTransport(options) {
    this.name    = "SendinBlue";
    this.version = pkg.version;

    if (isUndefined(options.apiUrl)) {
        options.apiUrl = "https://api.sendinblue.com/v2.0";
    }

    this.reqOptions = url.parse(options.apiUrl + "/email");
    this.reqOptions.method = "POST";
    this.reqOptions.headers = {
        "api-key": options.apiKey || "",
        "Content-Type": "application/json"
    };

    this.reqBuilder = this.reqOptions.protocol === "https:" ? https.request : http.request;
}

SendinBlueTransport.prototype.send = function (mail, callback) {
    var req = this.reqBuilder(this.reqOptions, function (res) {
        res.setEncoding("utf-8");

        var chunks = [];
        res.on("data", function (chunk) {
            chunks.push(chunk);
        }).on("end", function () {
            var body = {};

            try {
                var data = chunks.join("");
                body = JSON.parse(data);
            } catch (err) { /* Ignore error */ }

            if (isErrorResponse(res)) {
                return callback(responseError(res, body));
            }

            callback(undefined, makeInfo(body));
        });
    });

    req.on("error", function (err) {
        callback(prefixedErr(err, "error sending request"));
    });

    this.buildBody(mail).then(function (body) {
        req.write(JSON.stringify(body));
        req.end();
    }).catch(function (err) {
        callback(prefixedErr(err, "unable to build body"));
    });
};

SendinBlueTransport.prototype.buildBody = function (mail) {
    var data = mail.data;
    var body = {
        from:    transformFromAddresses(data.from),
        to:      transformAddresses(data.to),
        cc:      transformAddresses(data.cc),
        bcc:     transformAddresses(data.bcc),
        replyto: transformFromAddresses(data.replyTo),
        subject: data.subject,
        text:    data.text,
        html:    data.html,
        headers: data.headers
    };

    if (!data.attachments) {
        return Promise.resolve(body);
    }

    return buildAttachments(data.attachments).then(function (attachments) {
        body.attachment = attachments;
        return body;
    });
};

module.exports = function (options) {
    return new SendinBlueTransport(options);
};
