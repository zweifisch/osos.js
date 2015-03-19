
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

Client.prototype.updateMetadata = function(container, filename, metadata) {
    return request({
        method: "POST",
        headers: metadata,
        url: join(this.baseUrl, container, filename)
    });
};

Client.prototype.commit = function(container, filename, slices, contentType) {
    var commited = request({
        method: "PUT",
        body: JSON.stringify(slices),
        url: join(this.baseUrl, container, filename),
        params: {"multipart-manifest":"put"}
    });
    if (contentType) {
        return commited.then(function() {
            return this.updateMetadata(container, filename, {
                "Content-Type": contentType
            });
        }.bind(this));
    } else {
        return commited;
    }
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
                headers: slice.blob.type ? null : {"Content-Type": "application/octet-stream"},
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
        // var contentType = file.type ? null : "application/octet-stream";
        // return self.commit(container, filename, slices, contentType).then(checkStatus);
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
        headers: file.type ? null : {"Content-Type": "application/octet-stream"},
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
