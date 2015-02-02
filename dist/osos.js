(function(){
"use strict";

var Client = function(opts) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.delimiter = opts.delimiter || "/";
};

Client.prototype.getObjectInfo = function(container, path) {
    return request({
        method: "HEAD",
        url: join(this.baseUrl, container, path),
        getHeaders: ["Etag", "X-Static-Large-Object"]
    }).then(function(response) {
        return {
            etag: response.headers.Etag,
            isSLO: response.headers["X-Static-Large-Object"] === "True",
            isDLO: !!response.headers["X-Object-Manifest"]
        };
    });
};

Client.prototype.check = function(container, slice, path) {
    var etag = this.getObjectInfo(container, path);
    return Promise.all([slice.hash, etag]).then(function(vals) {
        log("local hash " + vals[0] + " remote " + vals[1].etag);
        return vals[0] === vals[1].etag;
    });
};

Client.prototype.commit = function(container, filename, slices) {
    return request({
        method: "PUT",
        body: JSON.stringify(slices),
        url: join(this.baseUrl, container, filename),
        params: {"multipart-manifest":"put"}
    });
};

Client.prototype.uploadSlice = function(container, slice, filename, onProgress) {
    var path = filename + "-" + slice.number;
    var uploaded = this.check(container, slice, path);
    var self = this;
    return uploaded.then(function(uploaded){
        if (uploaded) {
            log("slice " + slice.number + " already uploaded");
            return true;
        } else {
            log("uploading slice " + slice.number);
            return request({
                method:"PUT",
                body: slice.blob,
                url: join(self.baseUrl, container, path),
                token: self.token,
                onProgress: onProgress
            }).then(checkStatus);
        }
    });
};

Client.prototype.uploadAsSlices = function(file, filename, container, opts) {
    opts = opts || {};
    var sliceSize = (opts.sliceSize || 2) * 1024 * 1024;
    var concurrency = opts.concurrency || 2;
    var retry = opts.retry || 3;
    var slices = slicer(file, sliceSize);

    var queue = [];
    var rejected = false;

    var self = this;

    if (opts.onProgress) {
        var onProgress = function() {
            var loaded = queue.reduce(function(loaded, slice){
                if (slice.running) {
                    return loaded + (slice.loaded || 0);
                } else if (slice.blob) {
                    return loaded;
                }
                return loaded + slice.size;
            }, 0);
            opts.onProgress(loaded / file.size);
        };
    }

    return new Promise(function(resolve, reject) {
        var processSlice = function(slice) {
            var promise = self.uploadSlice(container, slice, filename, function(loaded) {
                this.loaded = loaded;
                opts.onProgress && onProgress();
            }.bind(slice));
            slice.running = true;
            queue.push(slice);
            promise.then(function() {
                slice.blob = undefined;
                slice.running = false;
                enqueue();
            });
            promise.catch(function(error) {
                slice.running = false;
                if (slice.retry < retry) {
                    log(slice.number, error);
                    enqueue();
                } else {
                    rejected = true;
                    log("max retry exceeded, give up");
                    reject(error);
                }
            });
            enqueue();
        };

        var getNext = function() {
            var failedTasks = queue.filter(function(x) {
                return x.blob && !x.running;
            });
            if (failedTasks.length) {
                return failedTasks[0];
            } else if (slices.slicesLeft()) {
                return slices.next();
            }
            return null;
        };

        var enqueue = function() {
            if (rejected) return;
            var taskRunning = queue.filter(function(x) {
                return x.running;
            });
            if (taskRunning.length >= concurrency) return;

            var slice = getNext();
            // log("queue length: " + queue.length);

            if (slice) {
                log("enqueue: slices " + slice.number);
                processSlice(slice);
            } else {
                taskRunning.length || resolve(queue);
            }
        };
        enqueue();
    });
};

Client.prototype.ensureContainer = function(container) {
    return request({
        method: "PUT",
        url: join(this.baseUrl, container),
        token: this.token
    }).then(checkStatus);
};

Client.prototype.upload = function(file, container, opts) {
    var filename = opts.name || file.name;
    var self = this;
    var segmentContainer = "_segments_" + container;
    var slices = this.ensureContainer(segmentContainer).then(function() {
        return self.uploadAsSlices(file, filename, segmentContainer, opts);
    });

    var commit = function(slices) {
        return self.commit(container, filename, slices).then(checkStatus);
    };
    
    return slices.then(function(slices) {
        slices = slices.sort(function(a, b) {
            return a.number - b.number;
        }).map(function(x) {
            return x.hash.then(function(hash) {
                return {
                    path: "/" + segmentContainer + "/" + filename + "-" + x.number,
                    etag: hash,
                    size_bytes: x.size
                };
            });
        });
        return self.ensureContainer(container).then(function(){
            return Promise.all(slices).then(commit);
        });
    });
};

Client.prototype.directUpload = function(file, container, opts) {
    opts = opts || {};
    var filename = opts.name || file.name;
    var onProgress;
    if (opts.onProgress) {
        onProgress = function(loaded, total) {
            opts.onProgress(loaded/total);
        };
    }
    return request({
        method: "PUT",
        body: file,
        url: join(this.baseUrl, container, filename),
        token: this.token,
        onProgress: onProgress
    }).then(checkStatus);
};

Client.prototype.listObjects = function(container, params) {
    params = params || {};
    params.format = params.format || "json";
    return request({
        method: "GET",
        url: join(this.baseUrl, container),
        params: params
    }).then(parseBody).then(attr("body"));
};

Client.prototype.listContainers = function(params) {
    params = params || {};
    params.format = params.format || "json";
    return request({
        method: "GET",
        url: this.baseUrl,
        params: params
    }).then(parseBody).then(attr("body"));
};

Client.prototype.delContainer = function(container) {
    return request({
        method: "DELETE",
        url: join(this.baseUrl, container)
    });
};

Client.prototype.delObject = function(container, path) {
    return this.getObjectInfo(container, path).then(function(info) {
        var opts = {
            method: "DELETE",
            url: join(this.baseUrl, container, path)
        };
        if (info.isSLO) {
            opts.params = {"multipart-manifest":"delete"};
        }
        return request(opts);
    }.bind(this));
};

Client.prototype.createFolder = function(container, path) {
    if (path.charAt(path.length - 1) !== this.delimiter) {
        path = path + this.delimiter;
    }
    return request({
        method: "PUT",
        url: join(this.baseUrl, container, path)
    });
};

var osos = {
    Client: Client
};

if ("undefined" != typeof exports) {
    exports.osos = osos;
} else {
    window.osos = osos;
}


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

})();