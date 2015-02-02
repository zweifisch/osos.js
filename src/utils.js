
var log = function(){};
if (localStorage.debug_osos) {
    log = function() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('UPLOAD');
        console.log.apply(console, args);
    };
}

var md5sum = function(blob) {
    var fileReader = new FileReader();
    var spark = new SparkMD5.ArrayBuffer();
    return new Promise(function(resolve, reject) {
        fileReader.onload = function(e) {
            spark.append(e.target.result);
            resolve(spark.end());
        };
        fileReader.onerror = function(error) {
            reject(error);
        };
        fileReader.readAsArrayBuffer(blob);
    });
};

var request = function(opts) {
    log("REQUEST", opts);
    return new Promise(function(resolve, reject) {

        var xhr = new XMLHttpRequest;

        var url = opts.url;
        if (opts.params) {
            url += "?" + makeQueryString(opts.params);
        }
        xhr.open(opts.method, url, true);

        if (opts.token) {
            xhr.setRequestHeader("X-Auth-Token", opts.token);
        }

        xhr.addEventListener("load", function() {
            var ret = {
                body: this.responseText,
                code: this.status
            };
            if (opts.getHeaders) {
                ret.headers = {};
                opts.getHeaders.forEach(function(header) {
                    ret.headers[header] = this.getResponseHeader(header);
                }.bind(this));
            }
            resolve(ret);
        });

        xhr.addEventListener("error", reject, false);
        xhr.upload.addEventListener("error", reject, false);

        if (opts.onProgress) {
            xhr.upload.addEventListener("progress", function(e) {
                opts.onProgress(e.loaded, e.total);
            });
        }

        xhr.send(opts.body);
    });
};

var checkStatus = function(response) {
    if (response.code >= 400) {
        throw Error(response.body);
    }
    return response;
};

var parseBody = function(response) {
    if (response.body) {
        response.body = JSON.parse(response.body);
    }
    return response;
};

var makeQueryString = function(obj) {
    var ret = [];
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            ret.push(encodeURIComponent(key) + "=" + encodeURIComponent(obj[key]));
        }
    }
    return ret.join("&");
};

var attr = function(name) {
    return function(object) {
        return object ? object[name] : null;
    };
};

var join = function() {
    return Array.prototype.slice.call(arguments).map(function(x) {
        if (!x || !x.length) {
            throw Error("illegal value in " + Array.prototype.slice.call(arguments).join(","));
        }
        if (x[0] === "/") {
            return x.substr(1);
        }
        return x;
    }).join("/");
};

var slicer = function(blob, sliceSize) {
    var index = 0;
    var slicesTotal = Math.ceil(blob.size / sliceSize);
    log("total slices: " + slicesTotal);
    return {
        next: function() {
            if (index < slicesTotal) {
                var b = blob.slice(sliceSize * index++, sliceSize * index);
                return {
                    blob: b,
                    number: index,
                    hash: md5sum(b),
                    size: index == slicesTotal ? blob.size - (slicesTotal - 1) * sliceSize : sliceSize
                };
            }
            return null;
        },
        slicesLeft: function() {
            return Math.max(slicesTotal - index, 0);
        },
        slicesTotal: slicesTotal
    };
};
