var assert        = require("assert");
var request       = require("request");
var _             = require("lodash");
var addressparser = require("addressparser");
var pkg           = require("../package.json");

//
// Constants
//
var STATUS_OK = 200;

//
// Helper
//
var responseErrorTpl = _.template("${message} (${code}, ${statusCode})");

function checkOptions(options) {
    var apiKey = options.apiKey;
    var apiUrl = options.apiUrl;

    assert(apiKey && _.isString(apiKey), "apiKey: must be a non-empty string");
    assert(apiUrl && _.isString(apiUrl), "apiUrl: must be a non-empty string");
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

function transformAddresses(addresses) {
    return flattenGroups(addressparser(addresses)).reduce(function (obj, address) {
        return addAddress(obj, address);
    }, {});
}

function transformFromAdresses(addresses) {
    var fromAddress = flattenGroups(addressparser(addresses))[0];

    return [fromAddress.address, fromAddress.name];
}

function isErrorResponse(response) {
    if (response.statusCode !== STATUS_OK) {
        return true;
    }

    return false;
}

function responseError(response, body) {
    return new Error(responseErrorTpl({
        message:    body.message || "server error",
        code:       body.code || "-",
        statusCode: response.statusCode
    }));
}

function makeInfo(data) {
    return {
        messageId: data["message-id"] || ""
    };
}

//
// Transport class
//
function SendinBlueTransport(options) {
    checkOptions(options);

    this.options = options;
    this.name    = "SendinBlue";
    this.version = pkg.version;
}

SendinBlueTransport.prototype.send = function (mail, callback) {
    request({
        uri: this.sendUrl(),
        method: "POST",
        headers: {
            "api-key": this.options.apiKey
        },
        json: true,
        body: this.transformData(mail.data)
    }, function (err, response, body) {
        if (err) {
            return callback(err);
        }

        if (isErrorResponse(response)) {
            return callback(responseError(response, body));
        }

        callback(null, makeInfo(body.data));
    });
};

SendinBlueTransport.prototype.sendUrl = function () {
    return this.options.apiUrl + "/email";
};

SendinBlueTransport.prototype.transformData = function (data) {
    return {
        from:    transformFromAdresses(data.from),
        to:      transformAddresses(data.to),
        cc:      transformAddresses(data.cc),
        bcc:     transformAddresses(data.bcc),
        replyto: transformFromAdresses(data.replyTo),
        subject: data.subject,
        text:    data.text,
        html:    data.html
    };
};

module.exports = function (options) {
    return new SendinBlueTransport(options);
};
