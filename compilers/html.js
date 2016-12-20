const transformer = require('jstransformer')
const he = require('he')
const common = require('./common')
const fmt = require('util').format

global.cache = {}

const IF_RE = /^\s*if\s*/
const IN_RE = /\s*in\s*/
const LINE_COMMENT_RE = /^\/\//
const FMT_RE = /["'](.*?)["'], /
const MIN_FILE_RE = /\.min$/
const EQ_RE = /^\s*=\s*/
const QUOTE_RE = /^"|'/

const COLON = 58
const PLUS = 43
const HYPHEN = 45
const A = 65
const Z = 90

function html (tree, data, location, cb) {
  let findElseBranch = false
  let logical = false

  // determine if this is a path or just regular content
  function getValue (data, info, str) {
    if (!EQ_RE.test(str)) return str
    let exp = str.replace(EQ_RE, '')
    if (FMT_RE.test(exp)) exp = '__format(' + exp + ')'
    logical = true
    const value = common.scopedExpression(data, info, exp)
    return he.escape(value + '')
  }

  function compile(child, index) {
    if (child.html) return child.html

    if (child.unescaped) {
      child.content = he.escape(child.content)
    }

    const firstLetter = child.tagOrSymbol.charCodeAt(0)
    //
    // first handle any flow control statements
    //
    if (child.tagOrSymbol === 'else') {
      if (!findElseBranch) return ''

      logical = true
      // if this is an else-if
      if (IF_RE.test(child.content)) {
        const exp = child.content.replace(IF_RE, '')
        if (common.scopedExpression(data, child.pos, exp)) {
          findElseBranch = false
          return html(child, data, location, cb)
        }
        return ''
      }

      findElseBranch = false
      return html(child, data, location, cb)
    }

    // if we are searching for an else branch, forget everything else.
    if (findElseBranch) {
      if (index == tree.children.length - 1) throw new Error('missing else')
      return ''
    }

    if (child.tagOrSymbol === 'comment') {
      return '<!--' + child.content + '-->'
    }

    if (child.tagOrSymbol === 'if') {
      logical = true
      if (common.scopedExpression(data, child.pos, child.content)) {
        return html(child, data, location, cb)
      }
      findElseBranch = true
      return ''
    }

    if (child.tagOrSymbol === 'while') {
      logical = true
      let value = ''
      while (common.scopedExpression(data, child.pos, child.content)) {
        value += html(child, data, location, cb)
      }
      return value
    }

    if (child.tagOrSymbol === 'for') {
      logical = true

      const parts = child.content.split(IN_RE)
      if (!parts[0]) common.die(child.pos, 'TypeError', 'Unknown mixin')

      const object = common.scopedExpression(data, child.pos, parts[1])

      let value = ''
      common.each(object, function (val, key) {
        // determine if there are identifiers for key and value
        const identifiers = parts[0].split(',')
        const keyIdentifier = identifiers[0]
        const valIdentifier = identifiers[1]
        const locals = { [keyIdentifier]: key }

        if (valIdentifier) {
          locals[valIdentifier] = val
        }
        // create a new shallow scope so that locals don't persist
        const scope = Object.assign({}, data, locals)
        value += html(child, scope, location, cb)
      })
      return value
    }

    if (child.tagOrSymbol === 'each') {
      common.die(child.pos, 'TypeError', 'Each not supported (use for)')
    }

    // treat all piped text as plain content
    if (child.tagOrSymbol === '|') {
      return (' ' + getValue(data, child.pos, child.content))
    }

    if (firstLetter === HYPHEN) {
      common.die(child.pos, 'Error', 'No inline code!')
    }

    if (firstLetter === COLON && cb) {
      logical = true
      const name = 'jstransformer-' + child.tagOrSymbol.slice(1)
      let t = null
      try {
        t = transformer(require(name))
      } catch (ex) {
        common.die(child.pos, 'Error', fmt('%s not installed', name))
      }
      const path = child.content
      const data = cb({ path, location })
      const parsed = t.render(data.tree, child.attributes)
      return parsed.body
    }

    // anything prefixed with '+' is a mixin call.
    if (firstLetter === PLUS && cb) {
      logical = true
      const name = child.tagOrSymbol.slice(1)
      if (!global.cache[name]) {
        common.die(child.pos, 'TypeError', 'Unknown mixin')
      }

      const locals = {}
      const args = Object.keys(child.attributes).map(attr => {
        return common.scopedExpression(data, child.pos, attr)
      })

      global.cache[name].keys.map((k, index) => (locals[k] = args[index]))
      const scope = Object.assign({}, data, locals)
      return html(global.cache[name].child, scope, location, cb)
    }

    // defines a mixin
    if (firstLetter >= A && firstLetter <= Z) {
      logical = true
      const keys = Object.keys(child.attributes)
      global.cache[child.tagOrSymbol] = { child, keys }
      return ''
    }

    if (child.tagOrSymbol === 'include') {
      // pass location to the cb so includes can be relative
      logical = true
      const path = child.content

      if (global.watcher) {
        global.addToWatcher(location, path)
      }

      // if the include is not a .min extension, it's plain text
      if (MIN_FILE_RE.test(path)) {
        const resolved = cb({ path, location }, true)
        return html(resolved.tree, data, resolved.location, cb)
      }
      return cb({ path, location })
    }

    //
    // everything else is a tag
    //
    const props = common.resolveTagOrSymbol(child.tagOrSymbol)

    let tag = ['<', props.tagname]

    if (props.id) {
      tag.push(' id="', props.id, '"')
    }

    if (props.classname) {
      tag.push(' class="', props.classname, '"')
    }

    if (child.attributes) {
      let attrs = Object.keys(child.attributes).map(key => {

        let value = child.attributes[key]

        // if this attribute is a boolean, make its value its key
        if (typeof value === 'boolean') {
          return [key, '=', `"${key}"`].join('')
        }

        if (value) {
          // all values are expressions
          value = common.scopedExpression(data, child.pos, value)

          // a class should not be empty
          if (key === 'class' && !value) return ''

          // data-* attributes should be escaped
          if (key.indexOf('data-') === 0) {
            value = he.escape(JSON.stringify(value))
          } else {
            value = JSON.stringify(value)
          }
        }
        return [key, '=', value].join('')
      })
      attrs = attrs.filter(a => !!a)
      if (attrs.length) tag.push(' ', attrs.join(' '))
    }

    tag.push('>') // html5 doesn't care about self closing tags

    if (child.content) {
      tag.push(getValue(data, child.pos, child.content))
    }

    // nothing left to decide, recurse if there are child nodes
    if (child.children.length) {
      tag.push(html(child, data, location, cb))
    }

    // decide if the tag needs to be closed or not
    if (common.unclosed.indexOf(props.tagname) === -1) {
      tag.push('</', props.tagname, '>')
    }

    var s = tag.join('')
    // if this is not a logical node, we can make an optimization
    if (!logical) child.html = s
    return s
  }

  if (tree.children && tree.children.length) {
    return tree.children.map(compile).join('')
  }
  return ''
}

module.exports = function (tree, data, location, cb) {
  cb = cb || common.resolveInclude
  data = data || {}
  return html(tree, data, location, cb)
}

