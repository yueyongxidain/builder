/**
 * @file transform to loader & config
 * @author nighca <nighca@live.cn>
 */

const webpack = require('webpack')
const update = require('immutability-helper')
const autoprefixer = require('autoprefixer')

const buildEnv = require('../../utils/build-env')
const paths = require('../../utils/paths')
const utils = require('../../utils')
const transforms = require('../../constants/transforms')

const regexpEscape = s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')

const makeExtensionPattern = extension => new RegExp(`\\.${regexpEscape(extension)}\$`)

const makeLoaderName = name => (
  /\-loader$/.test(name) ? name : `${name}-loader`
)

// 不支持 preset 简写的形式
const makeBabelPreset = preset => (
  typeof preset === 'string'
  ? require.resolve(preset)
  : [require.resolve(preset[0]), ...preset.slice(1)]
)

// TODO: 添加 babel-plugin- 前缀
const adaptBabelPluginName = name => require.resolve(name)

const makeBabelPlugin = plugin => (
  typeof plugin === 'string'
  ? adaptBabelPluginName(plugin)
  : [adaptBabelPluginName(plugin[0]), ...plugin.slice(1)]
)

/**
 * @desc 修改 babel-loader 的配置以适配 webpack2 (enable tree-shaking，由 webpack 来做 module 格式的转换)
 * 如果用户指定了 preset-env，则说明用户需要对 preset-env 进行特殊配置，则使用用户指定的配置
 * 否则，使用内置的默认配置（动态 polyfill） { "modules": false, useBuiltIns: 'entry', targets }
 * 注意后续可能要修改这边逻辑，考虑会对 import / export 进行转换的不一定只有 env 这个 preset
 * @param  {object} options babel options
 * @param  {object} targets babel env targets: https://babeljs.io/docs/en/babel-preset-env#targets
 * @return {object}
 * TODO: 检查现在 webpack4 是不是还需要 modules: false 的逻辑
 */
const makeBabelLoaderOptions = (options, targets, { addPolyfill }) => {
  options = options || {}

  const presets = options.presets || []
  const plugins = options.plugins || []

  const babelPresetEnvName = '@babel/preset-env'
  const presetPolyfillOptions = {
    useBuiltIns: 'entry',
    // corejs 选项在 @babel/preset-env 7.4.0 之后可用；
    // 若 @babel/preset-env 版本 >= 7.4.0，则此处需要显式指定版本为 2
    corejs: 2,
  }
  const defaultBabelPresetEnv = [babelPresetEnvName, {
    ...(
      addPolyfill && buildEnv.get() === buildEnv.prod
      ? presetPolyfillOptions
      : null
    ),
    modules: false,
    targets
  }]

  const babelPluginTransformRuntimeName = '@babel/plugin-transform-runtime'
  const defaultBabelPluginTransformRuntime = [babelPluginTransformRuntimeName, {
    corejs: 2
  }]

  const babelPresetEnv = presets.find(preset =>
    typeof preset === 'string'
    ? preset === babelPresetEnvName
    : preset[0] === babelPresetEnvName
  )

  const babelPluginTransformRuntime = plugins.find(plugin =>
    typeof plugin === 'string'
    ? plugin === babelPluginTransformRuntimeName
    : plugin[0] === babelPluginTransformRuntimeName
  )

  return update(options, {
    presets: {
      $set: (
        babelPresetEnv
        ? []
        : [defaultBabelPresetEnv]
      )
      .concat(presets)
      .map(makeBabelPreset)
    },
    plugins: {
      $set: (
        babelPluginTransformRuntime
        ? []
        : [defaultBabelPluginTransformRuntime]
      )
      .concat(plugins)
      .map(makeBabelPlugin)
    },
    sourceType: {
      // 用于指定预期模块类型，若用户未指定，则使用默认值 unambiguous，即：自动推断
      $set: options.sourceType || 'unambiguous'
    }
  })
}

const adaptLoader = ({ loader, options }) => {
  loader = makeLoaderName(loader)

  // 这里先前会把 loader 的值通过 `require.resolve` 替换为绝对路径
  // 目的是为了保证总是能拿到正确的一致的 loader 实现（不受项目本地 node_modules 中 loader 实现的影响）
  // 但是这样会有一些问题，比如 vue-loader 会通过正则匹配找到其中的 css-loader，而 resolve 后的绝对路径无法
  // 被匹配（从 vue-loader 的角度也很难实现），见 https://github.com/vuejs/vue-loader/blob/f5b944b3f7bc68d7e4afe7abbb4a8036301f76c0/lib/loader.js#L593
  // 结果是 vue-loader 不能正确地找到 css-loader 的位置，从而将 style-compiler 插到 less-loader 后边，导致不能正确编译 less 内容
  // 因此这里先把这个行为干掉，保持 loader 的值为其名字，即（`css-loader`, `less-loader` 这种形式）
  // `__loaderName__` 仍保留，builder 的实现中优先使用 `__loaderName__` 的值来判断 loader 的类型，而不是 loader 的值
  const loaderObj = { loader, options }

  // 添加 builder 后续处理需要的字段，`enumerable: false` 是为了防止 webpack 乱报错
  // 比如 extract-style 处要根据 `__loaderName__ === 'style-loader'` 判断是否需处理
  Object.defineProperty(loaderObj, '__loaderName__', {
    value: loader,
    enumerable: false,
    configurable: true
  })

  return loaderObj
}

const makeRule = (extension, context, exclude, ...loaderList) => {
  const rule = {
    test: makeExtensionPattern(extension),
    use: loaderList.map(adaptLoader)
  }

  // 添加 builder 后续处理需要的字段，`enumerable: false` 是为了防止 webpack 乱报错
  Object.defineProperty(rule, '__extension__', {
    value: extension,
    enumerable: false,
    configurable: true
  })

  if (context) {
    rule.issuer = makeExtensionPattern(context)
  }

  if (exclude != null) {
    rule.exclude = exclude
  }

  return rule
}

const addDefaultExtension = (config, extension) => {
  extension = extension && ('.' + extension)
  if (config.resolve.extensions.indexOf(extension) >= 0) {
    return config
  }
  return update(config, {
    resolve: {
      extensions: {
        $push: [extension]
      }
    }
  })
}

const makeReactBabelOptions = babelOptions => {
  const options = babelOptions || {}
  const presets = options.presets || []
  const plugins = options.plugins || []
  return utils.extend(options, {
    presets: presets.concat(['@babel/preset-react']),
    plugins: plugins.concat(['react-hot-loader/babel'])
  })
}

function makePostcssOptions({ autoprefixerOptions }) {
  autoprefixerOptions = utils.extend({
    overrideBrowserslist: []
  }, autoprefixerOptions)
  return {
    plugins: () => [autoprefixer(autoprefixerOptions)],
    ident: 'postcss' // https://github.com/postcss/postcss-loader/issues/281#issuecomment-319089901
  }
}

/**
 * @desc 构造处理 Javascript 内容时排除依赖用的正则
 * @param  {boolean|string[]} transformDeps 是否排除依赖，或需要被处理（不应该被排除）的依赖包名
 * @return {RegExp}
 */
function makeJsExcludePattern(transformDeps) {
  if (Array.isArray(transformDeps)) {
    return new RegExp(`node_modules/(?!(${transformDeps.join('|')})/).*`)
  }
  return transformDeps ? null : /node_modules\//
}

module.exports = (config, key, transform, buildConfig, post) => {
  if (!key || typeof key !== 'string') {
    throw new TypeError(`Invalid transform key: ${JSON.stringify(key)}`)
  }

  const { targets, optimization } = buildConfig
  const [extension, context] = key.split('@')

  const isTesting = buildEnv.get() === buildEnv.test

  if (typeof transform === 'string') {
    transform = {
      transformer: transform
    }
  }

  if (!transform || !transform.transformer || typeof transform.transformer !== 'string') {
    throw new TypeError(`Invalid transform info: ${JSON.stringify(transform)}`)
  }

  // 目前仅 vue 需要在其他 transform 加完后再加配置
  const postTransformers = [transforms.vue]
  if (post && postTransformers.indexOf(transform.transformer) < 0) {
    return config
  }

  // 针对后缀为 js 的 transform，控制范围（不对依赖做转换）
  const exclude = (
    (extension === 'js' || extension === 'ts')
      ? makeJsExcludePattern(optimization.transformDeps)
      : null
  )

  switch(transform.transformer) {
    case transforms.css:
    case transforms.less:
    case transforms.sass:
    case transforms.stylus: {
      const { modules, raw } = utils.extend({
        modules: false,
        raw: false
      }, transform.config)

      const postcssOptions = makePostcssOptions({
        autoprefixerOptions: { overrideBrowserslist: targets.browsers }
      })

      const cssOptions = {
        importLoaders: 1,
        modules: !!modules,
        localIdentName: '[local]_[hash:base64:5]'
      }

      const loaders = [];
      if (raw) {
        loaders.push({ loader: 'raw-loader' })
      } else {
        // 测试时无需 style-loader
        if (!isTesting) {
          loaders.push({ loader: 'style-loader' })
        }
        loaders.push({ loader: 'css-loader', options: cssOptions })
      }
      loaders.push({ loader: 'postcss-loader', options: postcssOptions })

      if (transform.transformer !== 'css') {
        loaders.push({
          loader: transform.transformer,
          options: transform.config && transform.config.options
        })
      }

      config = update(config, {
        module: { rules: {
          $push: [makeRule(extension, context, exclude, ...loaders)]
        } }
      })
      break
    }

    case transforms.babel: {
      const babelLoaderOptions = makeBabelLoaderOptions(transform.config, targets.browsers, optimization)
      config = addDefaultExtension(config, extension)
      config = update(config, {
        module: { rules: {
          $push: [makeRule(extension, context, exclude, { loader: 'babel', options: babelLoaderOptions })]
        } }
      })
      break
    }

    case transforms.jsx: {
      const transformConfig = utils.extend({
        babelOptions: undefined
      }, transform.config)

      config = addDefaultExtension(config, extension)
      config = update(config, {
        module: { rules: {
          $push: [makeRule(extension, context, exclude, {
            loader: 'babel',
            options: makeBabelLoaderOptions(
              makeReactBabelOptions(transformConfig.babelOptions),
              targets.browsers,
              optimization
            )
          })]
        } }
      })
      break
    }

    case transforms.ts:
    case transforms.tsx: {
      const transformConfig = utils.extend({
        // 默认开发模式跳过类型检查，提高构建效率，另，避免过严的限制
        transpileOnlyWhenDev: true,
        babelOptions: undefined
      }, transform.config)

      const babelOptions = (
        transform.transformer === transforms.tsx
        ? makeReactBabelOptions(transformConfig.babelOptions)
        : transformConfig.babelOptions
      )

      const tsLoaderOptions = {
        transpileOnly: (
          transformConfig.transpileOnlyWhenDev
          && buildEnv.get() === buildEnv.dev
        )
      }

      config = addDefaultExtension(config, extension)
      config = update(config, {
        module: { rules: {
          $push: [makeRule(
            extension,
            context,
            exclude,
            { loader: 'babel', options: makeBabelLoaderOptions(babelOptions, targets.browsers, optimization) },
            { loader: 'ts', options: tsLoaderOptions }
          )]
        } }
      })
      break
    }

    // TODO: 干掉对 flow 的支持吧
    case transforms.flow: {
      config = addDefaultExtension(config, extension)
      config = update(config, {
        module: { rules: {
          $push: [makeRule(extension, context, exclude, { loader: transform.transformer, options: transform.config })]
        } }
      })
      break
    }

    case transforms.file: {
      config = update(config, {
        module: { rules: {
          $push: [
            makeRule(extension, context, exclude, {
              loader: 'file',
              options: { name: 'static/[name]-[hash].[ext]' }
            })
          ]
        } }
      })
      break
    }

    case transforms.vue: {
      // 首次不处理，其它完成后再处理
      if (!post) break

      config = addDefaultExtension(config, extension)

      // 将外部其他的 transform 配置依样画葫芦配置到 vue-loader 里
      // 保持 vue 文件中对资源的处理逻辑与外部一致，除 postcss-loader 的行为外
      // 已知问题：vue-loader 使用 JSON.stringify 将 loader 的配置序列化，这里
      // postcss-loader 的配置中 plugins 字段是一个函数列表，函数会被 stringify 为 null
      // 导致后续执行报错，具体代码见：
      // https://github.com/vuejs/vue-loader/blob/407ddbd9e442fc8551d662d1709fcffd35419f21/lib/loader.js#L461
      // 这里把 use 中的 postcss-loader 项干掉，交给 vue-loader 的 style-compiler 调用 postcss 处理
      const postcssOptionsInVue = makePostcssOptions({ autoprefixerOptions: {
        overrideBrowserslist: targets.browsers
      } })
      const loadersInVue = config.module.rules.reduce(
        (loaders, rule) => {
          // 把 postcss-loader 的项干掉
          loaders[rule.__extension__] = rule.use.filter(
            loader => loader.__loaderName__ !== 'postcss-loader'
          )
          return loaders
        },
        {}
      )
      const options = {
        loaders: loadersInVue,
        postcss: postcssOptionsInVue
      }
      config = update(config, {
        module: { rules: {
          $push: [
            makeRule(extension, context, exclude, {
              loader: 'vue',
              options
            })
          ]
        } }
      })
      break
    }

    case transforms['svg-sprite']: {
      config = update(config, {
        module: { rules: {
          $push: [
            makeRule(extension, context, exclude, {
              loader: 'svg-sprite',
              options: {
                // TODO:
                // runtimeCompat 好像要被废弃了: https://github.com/kisenka/svg-sprite-loader/#runtimecompat-default-false-deprecated
                // 考虑通过 https://github.com/kisenka/svg-sprite-loader/#runtimegenerator-default-generator 实现类似的功能
                runtimeCompat: true,
                symbolId: '[name]-[hash]'
              }
            })
          ]
        } }
      })
      break
    }

    default: {
      config = update(config, {
        module: { rules: {
          $push: [makeRule(extension, context, exclude, { loader: transform.transformer, options: transform.config })]
        } }
      })
    }
  }

  return config
}
