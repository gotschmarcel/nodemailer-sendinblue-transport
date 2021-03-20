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
var STATUS_OK   = 200;

//
// V3 simple compliance
//
function V3Compliant() {

    var STATUS   = 201;
    var VERSION  = 2;

    var init = function(options) {
        var regex = new RegExp(/\/v[0-9]{1}/i);
        if (regex.test(options.apiUrl)) {
            VERSION = parseInt( regex.exec( options.apiUrl ).shift().substr(-1), 10 );   
        }
    };

    var body = function(body, data) {
        if (VERSION === 3) {
            delete body.from, body.text, body.html;
            Object.assign(body, { 
              sender: V3Compliant.address(data.from)
            });
            if (!data.params && !data.templateId) {
              Object.assign(body, { 
                textContent: data.text,
                htmlContent: data.html
            });
            }
            if (data.params) { 
                Object.assign(body, {
                    params: data.params
                });
            }
            if (data.templateId) { 
                Object.assign(body, {
                    templateId: data.templateId
                })
            }
            body.to = V3Compliant.addresses(data.to);
            body.cc = V3Compliant.addresses(data.cc);
            body.bcc = V3Compliant.addresses(data.bcc);
            body.replyto = V3Compliant.addresses(data.replyTo); 
        }
        return body;
    };

    var address = function(address) {
        if (typeof address === 'string') {
            return { email: address };
        }
        return address
    };

    var addresses = function(addresses) {
        if (Array.isArray(addresses)) {
            return addresses.map( (address) => {
              return V3Compliant.address(address);
            });
        }
        return V3Compliant.address(addresses);
    };

    var attachment = function(attachment) {
        return new Promise( (resolve, reject) => {
            if (!attachment.filename) {
                reject('one of name or filename is required');
            }
            if (!attachment.url && !attachment.path && !attachment.href && !attachment.content) {
                reject('one of url, path, href or content must be defined');
            }
            if (attachment.url || attachment.href) {
                resolve({ url : attachment.url || attachment.href, name: attachment.filename });
            } else if (attachment.path) {
                var data = fs.readFileSync(attachment.path);
                resolve({ content : data.toString("base64"), name: attachment.filename });
            } else if (attachment.content) {
                resolve({ content : /[A-Za-z0-9+/=]/.test(attachment.content) ? attachment.content : attachment.content.toString("base64"), name: attachment.filename });
            } else {
                resolve(null)
            }
        });
    };

    var attachments = function(attachments, callback) {
        return new Promise( (resolve, reject) => {
            if (VERSION === 2) {
                resolve( callback(attachments) );
            }
            if (!Array.isArray(attachments)) {
                reject('attachments property must be an array');
            }
            var generated = [];
            attachments.forEach( (attachment, index) => {
                V3Compliant.attachment(attachment)
                .then( (a) => {
                    generated.push(a);
                    if (index === attachments.length -1) { resolve(generated); }
                })
                .catch( (e) => {
                    reject(e.message);
                });
            })
        });
    };

    var statusCode = function(statusCode) {
        return VERSION === 3 ? statusCode === STATUS : statusCode === STATUS_OK;
    };

    var makeInfo = function(body,res) {
        if (VERSION === 3) {
            return {
                messageId: body["messageId"] || "",
                res: res
            };
        }
        return {
            messageId: body.data["message-id"] || "",
            code: body.code,
            message: body.message,
            res: res
        };
    };

    var self = {};
    
    self.init = init;
    self.body = body;
    self.address = address;
    self.addresses = addresses;
    self.statusCode = statusCode;
    self.makeInfo = makeInfo;
    self.attachment = attachment;
    self.attachments = attachments;

    return self;
}

var V3Compliant = V3Compliant();

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
            remote.push(attachment.href);
            return resolve();
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
    return !V3Compliant.statusCode(response.statusCode);
}

function responseError(response, body) {
    return new Error(
        util.format("%s (%s, %d)",
            body.message || "server error",
            body.code || "-",
            response.statusCode));
}

function makeInfo(body,res) {
    return V3Compliant.makeInfo(body,res);
}

/**
 * @description Transport class
 * @constructor
 */
function SendinBlueTransport(options) {

    this.name    = "SendinBlue";
    this.version = pkg.version;

    if (isUndefined(options.apiUrl)) {
        options.apiUrl = "https://api.sendinblue.com/v2.0";
    }

    V3Compliant.init(options);

    this.reqOptions = url.parse(options.apiUrl + "/email");
    this.reqOptions.method = "POST";
    this.reqOptions.headers = {
        "api-key": options.apiKey || "",
        "Content-Type": "application/json",
        "Accept": "application/json"
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

            callback(undefined, makeInfo(body, res));
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
        return Promise.resolve(V3Compliant.body(body, data));
    }

    return V3Compliant.attachments(data.attachments, buildAttachments)
    .then(function (attachments) {
        body.attachment = attachments;
        return V3Compliant.body(body, data);
    })
    .catch( (e) => { return body; });

};

module.exports = function (options) {
    return new SendinBlueTransport(options);
};
