const webpack = require('webpack');
const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const commitCount = require('git-commit-count');

const isDevelopment = process.env.NODE_ENV !== 'production';

module.exports = {
    mode: isDevelopment ? 'development' : 'production',
    devtool: false,
    entry: './boilerplate/entry.ts',
    output: {
        path: path.resolve('dist'),
        filename: '[name].[contenthash].js',
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        fallback: {
            crypto: false, // require.resolve('crypto-browserify'),
            https: false, // require.resolve('https-browserify'),
            http: false, // require.resolve('stream-http'),
            vm: false, // require.resolve('vm-browserify'),
            buffer: false, // require.resolve('buffer/'),
            os: false,
            fs: false,
            stream: false,
            tty: false,
            worker_threads: false,
            constants: false,
            assert: false,
            child_process: false,
            pnpapi: false,
        },
    },
    module: {
        rules: [
            {
                test: /\.css$/,
                use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
            },
            {
                test: /\.[jt]sx?$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: require.resolve('babel-loader'),
                    },
                ],
            },
            {
                test: [/\.(html)$/],
                use: 'raw-loader',
            },
            {
                test: /\.(gif|png|jpe?g|svg|xml|webp|gltf|fbx)$/i,
                use: 'file-loader',
            },
        ],
    },
    optimization: {
        splitChunks: {
            chunks: 'all',
        },
    },
    plugins: [
        new webpack.DefinePlugin({
            APP_VERSION: commitCount(),
            IS_GAME_CLIENT: JSON.stringify(true),
            CANVAS_RENDERER: JSON.stringify(true),
            WEBGL_RENDERER: JSON.stringify(true),
        }),
        new CleanWebpackPlugin(),
        new CopyPlugin({
            patterns: [
                {
                    from: 'assets',
                    to: 'assets',
                    filter: path => {
                        if (/\.(blend1?|aseprite|zip|afdesign)$/i.test(path)) {
                            return false;
                        }

                        return true;
                    }
                },
            ],
        }),
        new webpack.DefinePlugin({
            
        }),
        new HtmlWebpackPlugin({
            title: 'Sprixle',
            // template: './template.html',
            filename: 'index.html',
            inject: 'body',
        }),
    ],
};
