﻿/* eslint-env commonjs, amd */

// UMD based on https://github.com/umdjs/umd/blob/master/templates/returnExports.js
// TODO: move to ES6 and transpiler

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['jquery'], factory);
    } else if (typeof module === 'object' && module.exports) {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        module.exports = factory(require('jquery'));
    } else {
        // Browser globals (root is window)
        root.wvy = root.wvy || {};
        root.wvy.postal = root.wvy.postal || new factory(jQuery);
    }
}(typeof self !== 'undefined' ? self : this, function ($) {

    console.debug("postal.js");

    var WeavyPostal = function () {
        /**
         *  Reference to this instance
         *  @lends WeavyPostal#
         */
        var postal = this;

        var inQueue = [];
        var parentQueue = [];
        var messageListeners = [];
        var contentWindows = new Set();
        var contentWindowsByWeavyId = new Map();
        var contentWindowOrigins = new WeakMap();
        var contentWindowNames = new WeakMap();
        var contentWindowWeavyIds = new WeakMap();

        var _whenLeader = $.Deferred();
        var _isLeader = null;

        var _parentWeavyId = null;
        var _parentWindow = null;
        var _parentOrigin = null;
        var _parentName = null;
        var _origin = extractOrigin(window.location.href);

        function extractOrigin(url) {
            return /^(https?:\/\/[^/]+)\//.exec(url)[1] || null;
        }

        function distributeMessage(e) {
            var fromSelf = e.source === window && e.origin === _origin;
            var fromParent = e.source === _parentWindow && e.origin === _parentOrigin;
            var fromFrame = contentWindowOrigins.has(e.source) && e.origin === contentWindowOrigins.get(e.source);

            if (fromSelf || fromParent || fromFrame) {
                console.debug("postal: message from", fromSelf && "self" || fromParent && "parent" || fromFrame && "frame", e.data.name);

                var genericDistribution = !e.data.weavyId || e.data.weavyId === true;

                if (fromFrame && !e.data.windowName) {
                    e.data.windowName = contentWindowNames.get(e.source);
                }

                var messageName = e.data.name;
                if (messageName === "broadcast") {
                    e.data.name = e.data.broadcastName;
                }

                messageListeners.forEach(function (listener) {
                    var matchingName = listener.name === messageName || listener.name === "message";
                    var genericListener = listener.weavyId === null;
                    var matchingWeavyId = listener.weavyId === e.data.weavyId;

                    if (matchingName && (genericDistribution || genericListener || matchingWeavyId)) {
                        console.debug("postal: triggering listener", listener.name);

                        listener.handler(e);

                        if (listener.once) {
                            off(listener.name, listener.weavyId, listener.handler);
                        }
                    }
                });
            }
        }

        window.addEventListener("message", function (e) {
            if (e.data.name && e.data.weavyId !== undefined) {
                switch (e.data.name) {
                    case "register-child":
                        if (!_parentWindow) {
                            console.log("postal: registering child")
                            if (!contentWindowWeavyIds.has(e.source)) {
                                // get the real frame window
                                var frameWindow = Array.from(window.frames).filter(function (frame) {
                                    return frame === e.source;
                                }).pop();

                                if (frameWindow) {
                                    // get the frame element
                                    var frameElement = frameWindow.parent.document.getElementsByName(frameWindow.name)[0]
                                    if (frameElement) {
                                        var frameName = frameWindow.name;
                                        var frameWeavyId = frameElement.dataset.weavyId;
                                        registerContentWindow(frameWindow, frameName, frameWeavyId);
                                    }
                                }
                            }

                            var weavyId = contentWindowWeavyIds.get(e.source);
                            var contentWindowName = contentWindowNames.get(e.source);

                            try {
                                e.source.postMessage({
                                    name: "register-window",
                                    windowName: contentWindowName,
                                    weavyId: weavyId,
                                }, "*");
                            } catch (e) {
                                console.error("postal.register: Could not register frame window", weavyId, contentWindowName, e);
                            }
                        }
                        break;
                    case "register-window":
                        if (!_parentWindow) {
                            console.debug("postal: registering frame window", e.data.weavyId, e.data.windowName);
                            _parentOrigin = e.origin;
                            _parentWindow = e.source;
                            _parentName = e.data.windowName;
                            _parentWeavyId = e.data.weavyId;
                        }

                        console.debug("postal: is not leader");
                        _isLeader = false;
                        _whenLeader.reject({ parentName: _parentName, parentWeavyId: _parentWeavyId, parentOrigin: _parentOrigin });

                        e.source.postMessage({ name: "ready", windowName: e.data.windowName, weavyId: _parentWeavyId }, e.origin);

                        if (parentQueue.length) {
                            parentQueue.forEach(function (message) {
                                console.debug("postal: sending queued to parent:", message.name);

                                postToParent(message)
                            });
                            parentQueue = [];
                        }

                        if (inQueue.length) {
                            inQueue.forEach(function (messageEvent) {
                                distributeMessage(messageEvent)
                            });
                            inQueue = [];
                        }

                        break;
                    case "ready":
                        if (contentWindowsByWeavyId.has(e.data.weavyId) && contentWindowNames.has(e.source) && contentWindowsByWeavyId.get(e.data.weavyId).get(contentWindowNames.get(e.source))) {
                            console.debug("postal: ready, register origin", e.data.weavyId, contentWindowNames.get(e.source));
                            contentWindowOrigins.set(e.source, e.origin);
                            distributeMessage(e);
                        }

                        break;
                    case "reload":
                        window.location.reload();
                        break;
                    default:
                        if (e.source === window || _parentWindow || contentWindowsByWeavyId.size) {
                            console.debug("postal: distribute inbound message", e.data.weavyId, e.data.name);
                            distributeMessage(e);
                        } else {
                            console.debug("postal: queueing inbound message", e.data.weavyId, e.data.name)
                            inQueue.push(e);
                        }

                        break;
                }
            }
        });

        function on(name, weavyId, handler) {
            if (typeof arguments[1] === "function") {
                // omit weavyId argument
                handler = arguments[1];
                weavyId = null;
            }
            messageListeners.push({ name: name, handler: handler, weavyId: weavyId });
        }

        function one(name, weavyId, handler) {
            if (typeof arguments[1] === "function") {
                // omit weavyId argument
                handler = arguments[1];
                weavyId = null;
            }
            messageListeners.push({ name: name, handler: handler, weavyId: weavyId, once: true });
        }

        function off(name, weavyId, handler) {
            if (typeof arguments[1] === "function") {
                // omit weavyId argument
                handler = arguments[1];
                weavyId = null;
            }
            messageListeners = messageListeners.filter(function (listener) {
                return !(name === listener.name && handler === listener.handler && weavyId && weavyId === listener.weavyId);
            });
        }

        /**
         * Sends the id of a frame to the frame content scripts, so that the frame gets aware of which id it has.
         * The frame needs to have a unique name attribute.
         *
         * @category panels
         * @param {string} weavyId - The id of the group or entity which the contentWindow belongs to.
         * @param {Window} contentWindow - The frame window to send the data to.
         */
        function registerContentWindow(contentWindow, contentWindowName, weavyId) {
            try {
                if (!contentWindowName) {
                    console.error("postal.register: No valid contentWindow to register, must be a window and have a name.");
                    return;
                }
            } catch (e) {
                console.error("cannot access contentWindowName")
            }

            if (!weavyId || weavyId === "true") {
                weavyId = true;
            }

            if (!contentWindowsByWeavyId.has(weavyId)) {
                contentWindowsByWeavyId.set(weavyId, new Map());
            }

            contentWindowsByWeavyId.get(weavyId).set(contentWindowName, contentWindow);
            contentWindows.add(contentWindow);
            contentWindowNames.set(contentWindow, contentWindowName);
            contentWindowWeavyIds.set(contentWindow, weavyId);

            console.debug("register contentWindow", contentWindowName, weavyId);

        }

        function unregisterWeavyId(weavyId) {
            if (contentWindowsByWeavyId.has(weavyId)) {
                contentWindowsByWeavyId.delete(weavyId);
            }
        }

        function unregisterContentWindow(windowName, weavyId) {
            if (contentWindowsByWeavyId.has(weavyId)) {
                contentWindowsByWeavyId.get(weavyId).delete(windowName);
                if (contentWindowsByWeavyId.get(weavyId).size === 0) {
                    contentWindowsByWeavyId.delete(weavyId);
                }
            }
        }

        function postBroadcast(message, transfer) {
            if (typeof message !== "object" || !message.name) {
                console.error("postal: Invalid message format", message);
                return;
            }

            if (transfer === null) {
                // Chrome does not allow transfer to be null
                transfer = undefined;
            }

            message.broadcastName = message.name;
            message.name = "broadcast";
            message.weavyId = message.weavyId || true;

            if (_parentWindow) {
                try {
                    if (_parentWindow && _parentWindow !== window) {
                        _parentWindow.postMessage(message, _parentOrigin || "*", transfer);
                        console.debug("postal: Posted upstream broadcast message", message.name, message.broadcastName);
                    }
                } catch (e) {
                    console.error("postal: Error posting message", message.name, e);
                }
            }

            contentWindows.forEach(function (contentWindow) {
                try {
                    contentWindow.postMessage(message, "*", transfer);
                } catch (e) {
                    console.warn("postal: could not broadcast message to " + contentWindowNames.get(contentWindow))
                }
            })

        }

        function postToFrame(windowName, weavyId, message, transfer) {
            if (typeof message !== "object" || !message.name) {
                console.error("postal: Invalid message format", message);
                return;
            }

            if (transfer === null) {
                // Chrome does not allow transfer to be null
                transfer = undefined;
            }

            var contentWindow;
            try {
                contentWindow = contentWindowsByWeavyId.get(weavyId).get(windowName);
            } catch (e) {
                console.error("postal.postToFrame: Window not registered", weavyId, windowName);
            }

            if (contentWindow) {
                message.weavyId = weavyId;
                try {
                    contentWindow.postMessage(message, "*", transfer);
                } catch (e) {
                    console.error("Could not post message to frame", windowName)
                }
            }
        }

        function postToSelf(message, transfer) {
            if (typeof message !== "object" || !message.name) {
                console.error("postal: Invalid message format", message);
                return;
            }

            if (transfer === null) {
                // Chrome does not allow transfer to be null
                transfer = undefined;
            }

            message.weavyId = _parentWeavyId || true;

            try {
                window.postMessage(message, extractOrigin(window.location.href) || "*", transfer);
                console.debug("postal: Posted message to self", message);
            } catch (e) {
                console.error("postal: Could not post message to self");
            }
        }

        function postToParent(message, transfer, allowInsecure) {
            if (typeof message !== "object" || !message.name) {
                console.error("postal: Invalid message format", message);
                return;
            }

            if (message.weavyId === undefined) {
                message.weavyId = _parentWeavyId;
            }

            if (transfer === null) {
                // Chrome does not allow transfer to be null
                transfer = undefined;
            }

            if (_parentWindow) {
                try {
                    if (_parentWindow && _parentWindow !== window) {
                        _parentWindow.postMessage(message, _parentOrigin || "*", transfer);
                        console.debug("postal: Posted message", _parentWeavyId, _parentName, message.name);
                    }
                } catch (e) {
                    console.error("postal: Error posting message", message.name, e);
                }
            } else if (allowInsecure) {
                var parents = [];

                // Find all parent windows
                var nextWindow = window;
                while (nextWindow.top !== nextWindow) {
                    nextWindow = nextWindow.opener || nextWindow.parent;
                    parents.push(nextWindow);
                }

                parents.forEach(function (parent) {
                    try {
                        parent.postMessage(message, "*", transfer);
                        console.debug("postal: Posted insecure message", message.name)
                    } catch (e) {
                        console.error("postal: Error posting insecure message", message.name, e);
                    }
                });

            } else {
                console.debug("postal: queueing to parent", message.name);
                parentQueue.push(message);
            }

        }

        function postToSource(e, message, transfer) {
            if (e.source && e.data.weavyId !== undefined) {
                var fromSelf = e.source === window.self && e.origin === _origin;
                var fromParent = e.source === _parentWindow && e.origin === _parentOrigin;
                var fromFrame = contentWindowOrigins.has(e.source) && e.origin === contentWindowOrigins.get(e.source);

                if (transfer === null) {
                    // Chrome does not allow transfer to be null
                    transfer = undefined;
                }

                if (fromSelf || fromParent || fromFrame) {
                    message.weavyId = e.data.weavyId;
                    console.debug("postal: posted to source", message.name)
                    e.source.postMessage(message, e.origin, transfer);
                }
            }
        }

        function checkForParent() {
            var parents = [];

            // Find all parent windows
            var nextWindow = window.self;
            while (nextWindow.top !== nextWindow) {
                nextWindow = nextWindow.opener || nextWindow.parent;
                parents.unshift(nextWindow);
            }

            parents.forEach(function (parent) {
                try {
                    parent.postMessage({ name: "register-child", weavyId: true }, "*");
                    console.debug("postal: checking for parent")
                } catch (e) {
                    console.error("postal: Error checking for parent", e);
                }
            });

            requestAnimationFrame(function () {
                window.setTimeout(function () {
                    if (_whenLeader.state() === "pending") {
                        console.debug("postal: is leader");
                        _isLeader = true;
                        _whenLeader.resolve();
                    }
                }, 100);
            });
        }

        $(document).on("click", "[data-weavy-event]", function (e) {
            e.preventDefault();

            var name = $(this).data("weavy-name");

            postToParent.call(postal, { name: name });

            if (name === "signing-out") {
                var url = $(this).attr("href");
                // give weavy client a chance to disconnect from the hub
                window.setTimeout(function () { window.location.href = url }, 500);
            }
        });

        $(document).on("submit", "[data-weavy-event-notify]", function (e) {
            var name = $(this).data("weavyEventNotify");
            postToParent.call(postal, { name: name });
        });

        this.on = on;
        this.one = one;
        this.off = off;
        this.registerContentWindow = registerContentWindow;
        this.unregister = unregisterContentWindow;
        this.unregisterAll = unregisterWeavyId;
        this.postToFrame = postToFrame;
        this.postToParent = postToParent;
        this.postToSelf = postToSelf;
        this.postToSource = postToSource;
        this.postBroadcast = postBroadcast;
        this.extractOrigin = extractOrigin;
        this.whenLeader = _whenLeader.promise();

        Object.defineProperty(this, "isLeader", {
            get: function () { return _isLeader; }
        });
        Object.defineProperty(this, "parentWeavyId", {
            get: function () { return _parentWeavyId; }
        });
        Object.defineProperty(this, "parentName", {
            get: function () { return _parentName; }
        });
        Object.defineProperty(this, "parentOrigin", {
            get: function () { return _parentOrigin; }
        });

        checkForParent();
    };


    return new WeavyPostal();
}));


/**
 * @external Promise
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises
 */

/**
 * @external jqXHR
 * @see http://api.jquery.com/jQuery.ajax/#jqXHR
 */

/**
 * @external jqAjaxSettings
 * @see http://api.jquery.com/jquery.ajax/#jQuery-ajax-settings
 */


