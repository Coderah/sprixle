const webpack = require('webpack');
const path = require('path');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const commitCount = require('git-commit-count');

const isDevelopment = process.env.NODE_ENV !== 'production';

const typeCompiler = require('@deepkit/type-compiler');

module.exports = {
    mode: 'development',
    devtool: 'eval-source-map',
    devServer: {
        // contentBase: path.join(__dirname, 'dist'),
        compress: true,
        host: '0.0.0.0',
        port: 3000,
        // hot: true,
        static: {
            directory: path.resolve(__dirname, './assets'),
            publicPath: '/assets',
            watch: {
                ignored: /.(glb|blend|blend1|json)$/,
            },
        },
    },
    entry: './test/index.ts',
    output: {
        path: path.resolve('dist'),
        filename: '[name].[contenthash].js',
    },
    node: {
        // provides the global variable named "global"
        global: true,

        // provide __filename and __dirname global variables
        __filename: true,
        __dirname: true,
    },
    resolve: {
        extensions: ['.ts', '.js'],
        fallback: {
            crypto: false, // require.resolve('crypto-browserify'),
            https: false, // require.resolve('https-browserify'),
            http: false, // require.resolve('stream-http'),
            vm: false, // require.resolve('vm-browserify'),
            buffer: false, // require.resolve('buffer/'),
            assert: require.resolve('assert'),
            process: require.resolve('process/browser'),
            path: require.resolve('path-browserify'),
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
                test: /\.s[ac]ss$/i,
                use: [
                    // Creates `style` nodes from JS strings
                    'style-loader',
                    // Translates CSS into CommonJS
                    {
                        loader: 'css-loader',
                        options: {
                            url: false,
                        },
                    },
                    // Compiles Sass to CSS
                    'sass-loader',
                ],
            },
            {
                test: /\.tsx?$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        transpileOnly: true,
                        //this enables @deepkit/type's type compiler
                        getCustomTransformers: (program, getProgram) => ({
                            before: [typeCompiler.transformer],
                            afterDeclarations: [
                                typeCompiler.declarationTransformer,
                            ],
                        }),
                    },
                },
                exclude: /node_modules/,
            },
            // {
            //     test: /\.[jt]sx?$/,
            //     exclude: /node_modules/,
            //     use: [
            //         // ... other loaders
            //         {
            //             loader: require.resolve('babel-loader'),
            //             options: {
            //                 babelrcRoots: ['./', './src/sprixle'],
            //             },
            //         },
            //     ],
            // },
            {
                test: [/\.vert$/, /\.frag$/, /\.svg$/],
                use: 'raw-loader',
            },
        ],
    },
    optimization: {
        splitChunks: {
            chunks: 'all',
        },
    },
    plugins: [
        new webpack.ProvidePlugin({
            // you must `npm install buffer` to use this.
            process: ['process'],
        }),
        new webpack.DefinePlugin({
            'process.env.APP_VERSION': commitCount(),
            'process.env.IS_GAME_CLIENT': JSON.stringify(true),
        }),
        new CleanWebpackPlugin(),
        new CopyPlugin({
            patterns: [
                {
                    from: 'assets',
                    to: 'assets',
                    filter: (path) => {
                        if (/\.(blend1?|aseprite|zip|afdesign)$/i.test(path)) {
                            return false;
                        }

                        return true;
                    },
                },
            ],
        }),
        new webpack.DefinePlugin({
            CANVAS_RENDERER: JSON.stringify(true),
            WEBGL_RENDERER: JSON.stringify(true),
        }),
        new HtmlWebpackPlugin({
            title: 'Sprixle Tests',
            filename: 'index.html',
            inject: 'body',
        }),
    ],
};
