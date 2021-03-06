/* eslint-env commonjs, amd */

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
        root.wvy.connection = root.wvy.connection || new factory(jQuery);
    }
}(typeof self !== 'undefined' ? self : this, function ($) {
    console.debug("connection.js");

    function sanitizeObject(obj) {
        return JSON.parse(JSON.stringify(obj, function replacer(key, value) {
            // Filtering out properties
            // Remove HTML nodes
            if (value instanceof HTMLElement) {
                return value.toString();
            }
            return value;
        }));
    }

    // Tries to decode all string arguments for a given function
    // var objectLog = removeJSONbefore(console.log);
    // objectLog("test", '{"test":"hej"}', 123456)
    function removeJSONbefore(callback) {
        var callbackThis = this;
        return function () {
            var args = Array.from(arguments || []).map(function (value) {
                if (typeof value === "string") {
                    try {
                        return JSON.parse(value);
                    } catch (e) { /* Ignore catch */ }
                }
                return value;
            });

            return callback.apply(callbackThis, args);
        };
    }

    var connections = this;

    // CONNECTION HANDLING
    var _connections = new Map();

    var WeavyConnection = function (url) {
        /**
         *  Reference to this instance
         *  @lends WeavyConnection#
         */
        var weavyConnection = this;

        var initialized = false;

        var connectionUrl = "/signalr";
        var connectionDomain = window.location.origin;

        if (url) {
            // Add trailing slash
            url += /\/$/.test(url) ? "" : "/";

            connectionUrl = url + "signalr";

            var origin = /^(https?:\/\/.+)\//.exec(url)[1] || null;

            if (origin) {
                connectionDomain = origin;
            }
        }

        // create a new hub connection
        var connection = $.hubConnection(connectionUrl, { useDefaultPath: false });
        var reconnecting = false;
        var hubProxies = { rtm: connection.createHubProxy('rtm'), client: connection.createHubProxy('client') };
        var _events = [];
        var _reconnectTimeout = null;
        var _connectionTimeout = null;
        var reconnectRetries = 0;
        var explicitlyDisconnected = false;
        var connectInProgress = false;
        var authenticated = null;
        var userId = null;
        var whenConnectionStart;
        var whenConnected = $.Deferred();
        var whenLeaderElected = $.Deferred();

        var states = $.signalR.connectionState;
        var state = states.disconnected;
        var broadcastingConnection = null;
        var connectedAt = null;

        // Provide reverse readable state strings
        for (var stateName in states) {
            if (states.hasOwnProperty(stateName)) {
                states[states[stateName]] = stateName;
            }
        }

        function initUserId() {
            if (authenticated === null) {
                if (wvy.context && wvy.context.user) {
                    userId = wvy.context.user;
                    authenticated = userId !== -1;
                }
            }
        }

        function setUserId(newUserId) {
            userId = newUserId;
            if (wvy.context) {
                wvy.context.user = newUserId;
            }
        }

        //----------------------------------------------------------
        // Init the connection
        // url: the url to the /signalr 
        // windows: initial [] of windows to post incoming events to when embedded
        // force: if to connect event if the user is not logged in
        //----------------------------------------------------------
        function init(connectAfterInit) {
            if (!initialized) {
                initialized = true;
                console.debug("wvy.connection: init", connectionDomain, connectAfterInit ? "and connect" : "");

                initUserId();

                wvy.postal.whenLeader.then(function () {
                    console.log("connection postal is leader, let's go");
                    broadcastingConnection = false;
                    whenLeaderElected.resolve(true);
                    connectionStart();
                }, function () {
                    broadcastingConnection = true;
                    whenLeaderElected.resolve(false);
                });

                wvy.postal.on("broadcast", onBroadcastMessageReceived);

            }

            if (userId || connectAfterInit) {
                // connect to the server?
                return connect();
            } else {
                return whenLeaderElected.promise();
            }
        }

        function connect() {
            return whenLeaderElected.then(function (leader) {
                if (leader) {
                    connectionStart();
                } else {
                    wvy.postal.postBroadcast({ name: "request:connection-start" });
                }
                return whenConnected.promise();
            });
        }

        // start the connection
        function connectionStart() {
            explicitlyDisconnected = false;

            initUserId();

            if (status() === states.disconnected) {
                connectInProgress = true;
                state = states.connecting;
                triggerEvent("state-changed.connection.weavy", { state: state });

                whenConnectionStart = connection.start().always(function () {
                    connectInProgress = false;
                    whenConnected.resolve();
                });
            }

            return whenConnectionStart;
        }

        // stop connection
        function disconnect(async, notify) {
            if (!broadcastingConnection && connection.state !== states.disconnected && explicitlyDisconnected === false) {
                explicitlyDisconnected = true;

                try {
                    connection.stop(async === true, notify !== false).then(function () {
                        return Promise.resolve();
                    }).catch(function () {
                        return Promise.resolve();
                    });
                } catch (e) {
                    return Promise.resolve();
                }
            } else {
                return Promise.resolve();
            }
        }

        function disconnectAndConnect() {
            return new Promise(function (resolve) {
                explicitlyDisconnected = false;
                disconnect(true, false).then(function () {
                    connect().then(resolve);
                });
            });
        }

        function status() {
            return state;
        }

        // attach an event handler for the specified connection or server event, e.g. "presence", "typing" etc (see PushService for a list of built-in events)
        function on(event, handler) {
            if (event.indexOf(".connection") !== -1) {
                // .connection.weavy (connection events)
                event = event.indexOf(".weavy") === -1 ? event + ".weavy" : event;
            } else {
                // .rtmweavy (realtime events)
                event = event.indexOf(".rtmweavy") === -1 ? event + ".rtmweavy" : event;
            }
            _events.push([event, handler]);
            $(weavyConnection).on(event, null, null, handler);
        }

        // invoke a method on a server hub, e.g. "SetActive" on the RealTimeHub (rtm) or "Typing" on the MessengerHub (messenger).
        function invoke(hub, method, data) {
            var args = data ? [method, sanitizeObject(data)] : [method];

            var whenInvoked = new Promise(function (resolve, reject) {

                whenLeaderElected.then(function (leader) {
                    if (leader) {

                        console.debug("wvy.connection: invoke as leader", hub, args[0]);
                        var proxy = hubProxies[hub];

                        connect().then(function () {
                            proxy.invoke.apply(proxy, args)
                                .then(function (invokeResult) {

                                    // Try JSON parse
                                    if (typeof invokeResult === "string") {
                                        try {
                                            invokeResult = JSON.parse(invokeResult);
                                        } catch (e) { /* Ignore catch */ }
                                    }

                                    resolve(invokeResult);
                                })
                                .catch(function (error) {
                                    console.error(error, hub, args);
                                    reject(error);
                                });
                        });
                    } else {
                        // Invoke via broadcast
                        var invokeId = "wvy.connection-" + Math.random().toString().substr(2);
                        console.debug("wvy.connection: invoke via broadcast", hub, args[0], invokeId);

                        var invokeResult = function (msg) {
                            if (msg.data.name === "invokeResult" && msg.data.invokeId === invokeId) {
                                console.debug("wvy.connection: broadcast invokeResult received", invokeId);
                                if (msg.data.error) {
                                    reject(msg.data.error);
                                } else {
                                    var invokeResult = msg.data.result;

                                    // Try JSON parse
                                    if (typeof invokeResult === "string") {
                                        try {
                                            invokeResult = JSON.parse(invokeResult);
                                        } catch (e) { /* Ignore catch */ }
                                    }
                                    resolve(invokeResult);
                                }
                                wvy.postal.off("broadcast", invokeResult);
                            }
                        };

                        wvy.postal.on("broadcast", invokeResult);

                        wvy.postal.postBroadcast({ name: "invoke", hub: hub, args: args, invokeId: invokeId });
                    }
                });
            });

            return whenInvoked;
        }


        // configure logging and connection lifetime events
        connection.logging = false;

        connection.stateChanged(function (connectionState) {
            if (connectionState.newState === states.connected) {
                console.debug("wvy.connection: connected " + connection.id + " (" + connection.transport.name + ")");

                // clear timeouts
                window.clearTimeout(_reconnectTimeout);

                // reset retries
                reconnectRetries = 0;

                if (wvy.alert) {
                    wvy.alert.close("connection-state");
                } else {
                    triggerBroadcast("alert", "close", "connection-state");
                }

                whenConnected.resolve();

                // Trigger reconnected on connect excluding the first connect
                if (connectedAt) {
                    triggerEvent("reconnected.connection.weavy");
                }

                connectedAt = new Date();
            }

            state = connectionState.newState;
            // trigger event
            triggerEvent("state-changed.connection.weavy", { state: connectionState.newState });
        });

        connection.reconnected(function () {
            reconnecting = false;
        });

        connection.reconnecting(function () {
            reconnecting = true;
            console.debug("wvy.connection: reconnecting...");

            // wait 2 seconds before showing message
            if (_reconnectTimeout !== null) {
                window.clearTimeout(_reconnectTimeout);
            }

            _reconnectTimeout = setTimeout(function () {
                if (wvy.alert) {
                    wvy.alert.alert("warning", "Reconnecting...", null, "connection-state");
                } else {
                    triggerBroadcast("alert", "show", { type: "warning", title: "Reconnecting...", id: "connection-state" });
                }
            }, 2000);
        });

        connection.disconnected(function () {
            console.debug("wvy.connection: disconnected");

            if (!explicitlyDisconnected) {
                reconnectRetries++;
                window.clearTimeout(_connectionTimeout);

                if (reconnecting) {
                    connection.start();
                    reconnecting = false;
                } else {
                    // connection dropped, try to connect again after 5s
                    _connectionTimeout = setTimeout(function () {
                        connection.start();
                    }, 5000);
                }
            }

            // trigger event
            triggerEvent("disconnected.connection.weavy", { retries: reconnectRetries, explicitlyDisconnected: explicitlyDisconnected });

        });

        function triggerEvent(name) {

            var event = $.Event(name);

            // trigger event (with json object instead of string), handle any number of json objects passed from hub (args)
            var argumentArray = [].slice.call(arguments, 1);
            var data = argumentArray.map(function (a) {
                if (a && !$.isArray(a) && !$.isPlainObject(a)) {
                    try {
                        return JSON.parse(a);
                    } catch (e) {
                        console.warn("wvy.connection: could not parse event data;", name);
                    }
                }
                return a;
            });

            console.debug("wvy.connection: triggerEvent", name);
            $(weavyConnection).triggerHandler(event, data);
            triggerBroadcast("broadcast-event", name, data);
        }

        // trigger a message broadcast
        function triggerBroadcast(name, eventName, data) {
            try {
                wvy.postal.postBroadcast({ name: name, eventName: eventName, data: data });
            } catch (e) {
                console.error("wvy.connection: could not broadcast relay realtime message", { name: name, eventName: eventName }, e);
            }
        }

        // trigger a postMessage to the same window
        function triggerPostMessage(name) {
            wvy.postal.postToSelf({ name: name });
            triggerBroadcast("post-message-event", name);
        }

        // REALTIME EVENTS

        // generic callback used by server to notify clients that a realtime event happened
        // NOTE: we only need to hook this up in standalone, in the weavy client we wrap realtime events in the cross-frame-event and post to the frames
        function rtmEventRecieved(name, args) {
            if (name === "request:authentication.weavy") {
                console.debug("wvy.connection:", "rtm", "request:authentication.weavy");
                updateAuthenticationState.call(this);
            } else {
                name = name.indexOf(".rtmweavy" === -1) ? name + ".rtmweavy" : name;
                triggerEvent(name, args);
            }
        }

        hubProxies["rtm"].on("eventReceived", rtmEventRecieved);

        // AUTHENTICATION

        hubProxies["client"].on("user", removeJSONbefore(function (user) {
            console.debug("wvy.connection: client:user", user && user.id);
            var wasAuthenticated = !!authenticated;
            authenticated = user && user.id && user.id !== -1;
            if (!wasAuthenticated && authenticated || authenticated && userId !== user.id) {
                triggerEvent("user-change.connection.weavy", { state: "signed-in", user: user });
                setUserId(user.id);
            } else if (wasAuthenticated && !authenticated) {
                triggerEvent("user-change.connection.weavy", { state: "signed-out", user: user });
                setUserId(-1);
            }
        }));

        function updateAuthenticationState() {
            var authUrl = connectionUrl.substr(0, connectionUrl.lastIndexOf("/") + 1) + "a/users/authenticated";
            console.debug("wvy.connection: updateAuthenticationState");

            $.ajax(authUrl, {
                crossDomain: true,
                method: "GET",
                xhrFields: {
                    withCredentials: true
                }
            }).done(function (actualUserId) {
                if (actualUserId !== -1) {
                    if (!authenticated) {
                        console.debug("wvy.connection: updateAuthenticationState -> authenticated");
                        triggerPostMessage("signing-in");
                        triggerEvent("signing-in.connection.weavy");
                        disconnectAndConnect();
                    } else if (actualUserId !== userId) {
                        console.debug("wvy.connection: updateAuthenticationState -> authenticated as different user");

                        triggerEvent("user-change.connection.weavy", { state: "signed-out", user: { id: userId } });
                        triggerEvent("user-change.connection.weavy", { state: "signed-in", user: { id: actualUserId } });

                        disconnectAndConnect();
                    }
                } else {
                    if (authenticated) {
                        console.debug("wvy.connection: updateAuthenticationState -> unauthorized");
                        triggerPostMessage("signing-out");
                        triggerEvent("signing-out.connection.weavy");
                        disconnectAndConnect();

                        if (wvy.alert) {
                            wvy.alert.warning("You have been signed out. Reload to sign in again.");
                        }
                    }
                    setUserId(-1);
                }

            }).fail(function () {
                console.warn("wvy.connection: updateAuthenticationState request fail");
                authenticated = false;
                setUserId(-1);
            });
        }

        // SSO

        var ssoStates = {
            /** Authentication has not started */
            uninitialized: 0,
            0: "uninitialized",
            /** Currently authenticating */
            authenticating: 1,
            1: "authenticating",
            /** Authentication process complete and user is authorized */
            authorized: 2,
            2: "authorized",
            /** Authentication process failed and the user is unauthorized */
            unauthorized: 3,
            3: "unauthorized"
        };

        var ssoState = ssoStates.uninitialized;

        // Set Single Sign On JWT token for the connection
        function sso(jwt) {
            var jwtIsNew = !connection.qs || !connection.qs.jwt || connection.qs.jwt !== jwt;
            connection.qs = connection.qs || {};
            connection.qs.jwt = jwt;
            whenLeaderElected.then(function (leader) {
                triggerBroadcast("sso-token", jwt);
            });

            if (jwtIsNew) {
                whenConnected.then(function () {
                    if (connection.qs.jwt) {
                        invoke("client", "ValidateSSO", connection.qs.jwt).then(processSSO);
                    }
                });
            }
        }

        // Triggered when SSO authentication is needed
        hubProxies["client"].on("sso", removeJSONbefore(processSSO));


        function processSSO(ssoData) {
            var ssoUrl = connectionUrl.substr(0, connectionUrl.lastIndexOf("/") + 1) + "sign-in-token";
            console.debug("wvy.connection: client:sso", ssoStates[ssoData.state]);
            ssoState = ssoData.state;
            triggerBroadcast("sso-state", ssoState);

            if (ssoData.state === ssoStates.authenticating && connection.qs.jwt) {
                console.debug("wvy.connection: signing in with JWT token");

                triggerPostMessage("signing-in");
                triggerEvent("signing-in.connection.weavy", { method: "sso" });

                $.ajax(ssoUrl, {
                    crossDomain: true,
                    data: "jwt=" + connection.qs.jwt,
                    method: "POST",
                    xhrFields: {
                        withCredentials: true
                    }
                }).done(function (user) {
                    ssoState = ssoStates.authorized;
                    console.debug("wvy.connection: signed in with JWT token", user.id);
                    triggerBroadcast("sso-state", ssoState);
                    triggerPostMessage("signed-in");
                    triggerEvent("signed-in.connection.weavy", { method: "sso" });
                }).fail(function () {
                    ssoState = ssoStates.unauthorized;
                    console.warn("wvy.connection: sign in with JWT token failed");
                    triggerBroadcast("sso-state", ssoState);
                    triggerPostMessage("authentication-error");
                    triggerEvent("authentication-error.connection.weavy", { method: "sso" });
                });
            }

            // Clear connection query string JWT to reset SSO
            triggerBroadcast("sso-clear");
            if (connection.qs && connection.qs.jwt) {
                delete connection.qs.jwt;
            }
        }


        // LEGACY CLIENT

        // callback from weavy client onload
        function weavyLoaded(args) {
            var name = "loaded.rtmweavy.weavy";
            triggerEvent(name, args);
        }
        hubProxies["client"].on("loaded", weavyLoaded);

        // REALTIME CROSS WINDOW MESSAGE
        // handle cross frame events from rtm
        var onBroadcastMessageReceived = function (e) {
            var msg = e.data;
            console.debug("wvy.connection: broadcast received", msg.name, msg.eventName || "");
            switch (msg.name) {
                case "invoke":
                    whenLeaderElected.then(function (leader) {
                        if (leader) {
                            var proxy = hubProxies[msg.hub];
                            var args = msg.args;
                            console.debug("wvy.connection: processing invoke request", msg.invokeId, msg.args);
                            connect().then(function () {
                                proxy.invoke.apply(proxy, args)
                                    .then(function (invokeResult) {
                                        console.debug("wvy.connection: returning invoke request result", msg.args[0], msg.invokeId);
                                        wvy.postal.postBroadcast({
                                            name: "invokeResult",
                                            hub: msg.hub,
                                            args: args,
                                            result: invokeResult,
                                            invokeId: msg.invokeId
                                        });
                                    })
                                    .catch(function (error) {
                                        console.error(error);
                                        wvy.postal.postBroadcast({
                                            name: "invokeResult",
                                            hub: msg.hub,
                                            args: args,
                                            error: error,
                                            invokeId: msg.invokeId
                                        });
                                    });
                            });
                        }

                    });
                    break;
                case "request:connection-start":
                    whenLeaderElected.then(function (leader) {
                        if (leader) {
                            connect().then(function () {
                                wvy.postal.postBroadcast({ name: "connection-started" });
                            });
                        }
                    });
                    break;
                case "connection-started":
                    whenLeaderElected.then(function (leader) {
                        if (!leader) {
                            state = states.connected;
                            whenConnected.resolve();
                        }
                    });
                    break;
                case "post-message-event":
                    wvy.postal.postToSelf({ name: msg.eventName });
                    break;
                case "broadcast-event":
                    var name = msg.eventName;
                    var event = $.Event(name);
                    var data = msg.data;

                    // Extract array with single value
                    if ($.isArray(data) && data.length === 1) {
                        data = data[0];
                    }

                    if (name === "user-change.connection.weavy") {
                        if (data.state === "signed-in") {
                            authenticated = true;
                            setUserId(data.user.id);
                        }
                        if (data.state === "signed-out") {
                            authenticated = false;
                            setUserId(-1);
                        }
                    }

                    if (name === "state-changed.connection.weavy") {
                        state = data.state;
                        if (state === states.connected) {
                            whenConnected.resolve();
                        }
                    }

                    console.debug("wvy.connection: triggering received broadcast-event", name);
                    $(weavyConnection).triggerHandler(event, msg.data);
                    break;
                case "sso-token":
                    connection.qs = connection.qs || {};
                    connection.qs.jwt = msg.data;
                    break;
                case "sso-state":
                    ssoState = msg.data;
                    break;
                case "sso-clear":
                    if (connection.qs && connection.qs.jwt) {
                        delete connection.qs.jwt;
                    }
                    break;
                case "alert":
                    if (wvy.alert) {
                        if (msg.eventName === "show") {
                            wvy.alert.alert(msg.data.type, msg.data.title, null, msg.data.id);
                        } else {
                            wvy.alert.close(msg.data);
                        }
                    }
                    break;
                default:
                    return;
            }

        };


        function destroy() {
            disconnect();

            authenticated = null;
            userId = null;
            reconnecting = false;

            window.clearTimeout(_reconnectTimeout);
            window.clearTimeout(_connectionTimeout);

            try {
                hubProxies["rtm"].off("eventReceived", rtmEventRecieved);
            } catch (e) { /* Ignore catch */ }

            try {
                hubProxies["client"].off("loaded", weavyLoaded);
            } catch (e) { /* Ignore catch */ }

            _events.forEach(function (eventHandler) {
                var name = eventHandler[0], handler = eventHandler[1];
                $(weavyConnection).off(name, null, handler);
            });
            _events = [];
        }

        return {
            connect: connect,
            destroy: destroy,
            disconnect: disconnect,
            init: init,
            invoke: invoke,
            isAuthenticated: function () { return authenticated; },
            on: on,
            proxies: hubProxies,
            sso: sso,
            states: states,
            status: status,
            transport: function () { return connection.transport.name; }
        };
    };

    connections.get = function (url) {
        var sameOrigin = url ? window.location.origin === (/^(https?:\/\/.+)\//.exec(url)[1] || null) : false;
        url = (sameOrigin ? "" : url) || "";
        console.log("connection is sameorigin", sameOrigin);
        if (_connections.has(url)) {
            return _connections.get(url);
        } else {
            var connection = new WeavyConnection(url);
            _connections.set(url, connection);
            return connection;
        }
    };

    connections.remove = function (url) {
        url = url || "";
        try {
            var connection = _connections.get(url);
            if (connection && connection.destroy) {
                connection.destroy();
            }
            _connections.delete(url);
        } catch (e) {
            console.error("Could not remove connection", url, e);
        }
    };

    // expose wvy.connection.default. self initiatied upon access and no other connections are active 
    Object.defineProperty(connections, "default", {
        get: function () {
            if (_connections.has("")) {
                return _connections.get("");
            } else {
                var connection = connections.get();

                $(function () {
                    setTimeout(function () {
                        if (_connections.size === 1) {
                            console.debug("wvy.connection self init");
                            connection.init();
                        }
                    }, 1);
                });

                return connection;
            }
        }
    });

    // Bridge for simple syntax and backward compatibility with the mobile apps
    Object.defineProperty(connections, "on", {
        get: function () {
            return connections.default.on;
        }
    });

    // Bridge for simple syntax
    Object.defineProperty(connections, "invoke", {
        get: function () {
            return connections.default.invoke;
        }
    });
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
