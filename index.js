'use strict';
/**
 * Module dependencies.
 */

var debug = require('debug')('koa-session-redis'),
    uid = require('uid2'),
    thunkify = require('thunkify'),
    redis = require('redis');

/**
 * Initialize session middleware with `opts`:
 *
 * - `key` session cookie name ["koa:sess"]
 * - all other options are passed as cookie options
 *
 * @param {Object} [opts]
 * @api public
 */

module.exports = function (opts) {
  var key, client, redisOption, cookieOption;

  opts = opts || {};
  // key
  key = opts.key || 'koa:sess';
  debug('key config is: %s', key);

  //cookies opts
  cookieOption = opts.cookie || {};
  debug('cookie config all: %j', cookieOption);
  debug('cookie config overwrite: %s', (cookieOption.overwrite === false) ? false : (cookieOption.overwrite = true));
  debug('cookie config httpOnly: %s', (cookieOption.httpOnly === false) ? false : (cookieOption.httpOnly = true));
  debug('cookie config signed: %s', (cookieOption.signed === false) ? false : (cookieOption.signed = true));

  //redis opts
  redisOption = opts.store || {};
  debug('redis config all: %j', redisOption);
  debug('redis config port: %s', redisOption.port || (redisOption.port = 6379));
  debug('redis config host: %s', redisOption.host || (redisOption.host = '127.0.0.1'));
  debug('redis config options: %j', redisOption.options || (redisOption.options = {}));
  debug('redis config db: %s', redisOption.db || (redisOption.db = 0)); //TODO: switch to another db
  debug('redis config ttl: %s', redisOption.ttl || (redisOption.ttl = null)); //TODO: ttl feature

  //redis client for session
  client = redis.createClient(
    redisOption.port,
    redisOption.host,
    redisOption.options
  );
  client.get = thunkify(client.get);
  client.set = thunkify(client.set);
  client.del = thunkify(client.del);

  client.on('connect', function () {
    debug('redis is connecting');
  });

  client.on('ready', function () {
    debug('redis ready');
    debug('redis host: %s', client.host);
    debug('redis port: %s', client.port);
    debug('redis parser: %s', client.reply_parser.name);
  });

  client.on('reconnect', function () {
    debug('redis is reconnecting');
  });

  client.on('error', function (err) {
    debug('redis encouters error: %j', err);
  });

  client.on('end', function () {
    debug('redis connection ended');
  });

  return function *(next) {
    var sess, sid, json, err;

    // to pass to Session()
    this.cookieOption = cookieOption;
    this.sessionKey = key;
    this.sessionId = null;

    sid = this.cookies.get(key, cookieOption);

    if (sid) {
      debug('sid %s', sid);
      try {
        json = yield client.get(sid);
      }catch (e) {
        debug('encounter error %s', e);
        json = null;
      }
    }

    if (json) {
      this.sessionId = sid;
      debug('parsing %s', json);
      try {
        sess = new Session(this, decode(json));
      } catch (err) {
        // backwards compatibility:
        // create a new session if parsing fails.
        // new Buffer(string, 'base64') does not seem to crash
        // when `string` is not base64-encoded.
        // but `JSON.parse(string)` will crash.
        if (!(err instanceof SyntaxError)) throw err;
        sess = new Session(this);
      }
    } else {
      sid = this.sessionId = uid(24);
      debug('new session');
      sess = new Session(this);
    }

    this.__defineGetter__('session', function () {
      // already retrieved
      if (sess) return sess;
      // unset
      if (false === sess) return null;
    });

    this.__defineSetter__('session', function (val) {
      if (null === val) return sess = false;
      if ('object' === typeof val) return sess = new Session(this, val);
      throw new Error('this.session can only be set as null or an object.');
    });

    try {
      yield *next;
    } catch (_err) {
      err = _err;
    }

    if (undefined === sess) {
      // not accessed
    } else if (false === sess) {
      // remove
      this.cookies.set(key, '', cookieOption);
      yield client.del(sid);
    } else if (!json && !sess.length) {
      // do nothing if new and not populated
    } else if (sess.changed(json)) {
      // save
      json = sess.save();
      yield client.set(sid, json);
    }

    // rethrow any downstream errors
    if (err) throw err;
  };
};

/**
 * Session model.
 *
 * @param {Context} ctx
 * @param {Object} obj
 * @api private
 */

function Session(ctx, obj) {
  this._ctx = ctx;
  if (!obj) this.isNew = true;
  else for (var k in obj) this[k] = obj[k];
}

/**
 * JSON representation of the session.
 *
 * @return {Object}
 * @api public
 */

Session.prototype.inspect =
  Session.prototype.toJSON = function () {
  var self = this;
  var obj = {};

  Object.keys(this).forEach(function (key) {
    if ('isNew' === key) return;
    if ('_' === key[0]) return;
    obj[key] = self[key];
  });

  return obj;
};

/**
 * Check if the session has changed relative to the `prev`
 * JSON value from the request.
 *
 * @param {String} [prev]
 * @return {Boolean}
 * @api private
 */

Session.prototype.changed = function (prev) {
  if (!prev) return true;
  this._json = encode(this);
  return this._json !== prev;
};

/**
 * Return how many values there are in the session object.
 * Used to see if it's "populated".
 *
 * @return {Number}
 * @api public
 */

Session.prototype.__defineGetter__('length', function () {
  return Object.keys(this.toJSON()).length;
});

/**
 * populated flag, which is just a boolean alias of .length.
 *
 * @return {Boolean}
 * @api public
 */

Session.prototype.__defineGetter__('populated', function () {
  return !!this.length;
});

/**
 * Save session changes by
 * performing a Set-Cookie.
 *
 * @api private
 */

Session.prototype.save = function () {
  var ctx = this._ctx,
      json = this._json || encode(this),
      sid = ctx.sessionId,
      opts = ctx.cookieOption,
      key = ctx.sessionKey;

  debug('save %s', json);
  ctx.cookies.set(key, sid, opts);
  return json;
};

/**
 * Decode the base64 cookie value to an object.
 *
 * @param {String} string
 * @return {Object}
 * @api private
 */

function decode(string) {
  var body = new Buffer(string, 'base64').toString('utf8');
  return JSON.parse(body);
}

/**
 * Encode an object into a base64-encoded JSON string.
 *
 * @param {Object} body
 * @return {String}
 * @api private
 */

function encode(body) {
  body = JSON.stringify(body);
  return new Buffer(body).toString('base64');
}
