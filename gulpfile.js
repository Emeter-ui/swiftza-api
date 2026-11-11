const {src, dest} = require('gulp');
const sourceMaps = require('gulp-sourcemaps')
const minifyJs = require('gulp-uglify');
const concat = require('gulp-concat')

const bundleJs = ()=>{
    return src('./src/index.js')
    .pipe(sourceMaps.init())
    .pipe(minifyJs())
    .pipe(concat('bundle.js'))
    .pipe(sourceMaps.write())
    .pipe(dest('./dist/public'))
}


exports.bundleJs = bundleJs