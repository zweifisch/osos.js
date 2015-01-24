var gulp = require("gulp");
var wrap = require("gulp-wrap");
var concat = require("gulp-concat");

gulp.task("default", function() {
    gulp.src("./src/*.js")
        .pipe(concat('osos.js'))
        .pipe(wrap('(function(){\n"use strict";\n<%= contents %>\n})();'))
        .pipe(gulp.dest("./dist"));
});
