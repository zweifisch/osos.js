# osos

an openstack object-storage client for browser

## usage

create a client

```javascript
var client = new osos.Client({
    baseUrl: "http://object-storage.com/v1/project",
    token: "token"
});
```

### uploading

uploading large file

```javascript
var promise = client.upload(file, container, {
    sliceSize: 2, // Mb
    concurrency: 2,
    retry: 3
});

promise.then(function() {
    console.log("done");
});
```

uploading small file

```javascript
client.directUpload(file, container);
```

progress

```javascript
client.upload(file, container, {
    onProgress: function(progress) {
        console.log(progress);
    }
})
```

### more api

```javascript
client.listContainers()
client.listOjbects(container)
client.delObject(container, object)
});
```

### examples

working in progress examples included, reactjs is required(run `bower install`)

a proxy is also needed, nginx can be configured as following:

```nginx
server {
    listen 8000;
    root /path/to/osos/;
    client_max_body_size 20M;

    location /v1 {
        proxy_pass http://object-storage:8080;
    }
}
```

## dependencies

* depends on native es6 `Promise`, you might need a [shim][shim] for older browsers
* [spark-md5][spark-md5] for `upload`

[shim]: https://github.com/jakearchibald/es6-promise
[spark-md5]: https://github.com/satazor/SparkMD5
