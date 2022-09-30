const webpack = require('webpack');
const path = require('path');
const config = require('./webpack.config');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
    ...config,
    mode: 'development',
    devtool: 'eval-source-map',
    devServer: {
        compress: true,
        host: '0.0.0.0',
        port: 5966,
    },
    plugins: [...config.plugins],
};
