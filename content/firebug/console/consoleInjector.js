/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/chrome/reps",
    "firebug/lib/locale",
    "firebug/lib/events",
    "firebug/lib/url",
    "firebug/js/stackFrame",
    "firebug/firefox/window",
    "firebug/console/console",
    "firebug/lib/array",
    "firebug/console/consoleExposed",
    "firebug/console/errors",
],
function(Obj, Firebug, FirebugReps, Locale, Events, Url, StackFrame, Win, Console, Arr) {

// ********************************************************************************************* //
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

// ********************************************************************************************* //
// Console Injector

Firebug.Console.injector =
{
    isAttached: function(context, win)
    {
        var handler = this.getConsoleHandler(context, win);

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("Console.isAttached "+handler+" in context "+context.getName()+
                " and win "+Win.safeGetWindowLocation(win), handler);

        return handler;
    },

    attachIfNeeded: function(context, win)
    {
        if (this.isAttached(context, win))
            return true;

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("Console.attachIfNeeded found isAttached false " +
                Win.safeGetWindowLocation(win));

        this.attachConsoleInjector(context, win);
        this.addConsoleListener(context, win);

        Firebug.Console.clearReloadWarning(context);

        var attached =  this.isAttached(context, win);
        if (attached)
            Events.dispatch(Firebug.Console.fbListeners, "onConsoleInjected", [context, win]);

        return attached;
    },

    attachConsoleInjector: function(context, win)
    {
        // Get the 'console' object (this comes from chrome scope).
        var console = Firebug.ConsoleExposed.createFirebugConsole(context, win);

        // Do not expose the chrome object as is but, rather do a wrapper, see below.
        //win.wrappedJSObject.console = console;
        //return;

        // Construct a script string that defines a function. This function returns
        // an object that wraps every 'console' method. This function will be evaluated
        // in a window content sandbox and return a wrapper for the 'console' object.
        // Note that this wrapper appends an additional frame that shouldn't be displayed
        // to the user.
        var expr = "(function(x) { return {";
        for (var p in console)
        {
            var func = console[p];
            if (typeof(func) == "function")
            {
                expr += p + ": function() { return Function.apply.call(x." + p +
                    ", x, arguments); },";
            }
            else if (p == "firebug")
            {
                expr += p + ":" + console.firebug + ",";
            }
        }
        expr += "};})";

        // Evaluate the function in the window sandbox/scope and execute. The return value
        // is a wrapper for the 'console' object.
        var sandbox = Cu.Sandbox(win);
        var getConsoleWrapper = Cu.evalInSandbox(expr, sandbox);
        win.wrappedJSObject.console = getConsoleWrapper(console);
    },

    addConsoleListener: function(context, win)
    {
        if (!win)
            win = context.window;

        var handler = this.getConsoleHandler(context, win);
        if (handler)
            return;

        win.document.setUserData("firebug-Version", Firebug.version, null); // Initialize Firebug version.

        var handler = createConsoleHandler(context, win);
        win.document.setUserData("firebug-Token", handler.token, null); // Initialize Firebug token

        this.setConsoleHandler(context, win, handler);

        return true;
    },

    getConsoleHandler: function(context, win)
    {
        if (!win.document)
        {
            if (FBTrace.DBG_ERRORS)
                FBTrace.sysout("console.getConsoleHandler; NO DOCUMENT", {win:win, context:context});
            return null;
        }

        var attachedToken = win.document.getUserData("firebug-Token");
        if (context.activeConsoleHandlers)
        {
            for(var i = 0; i < context.activeConsoleHandlers.length; i++)
            {
                if (context.activeConsoleHandlers[i].token === attachedToken)
                    return context.activeConsoleHandlers[i];
            }
        }
    },

    removeConsoleHandler: function(context, win)
    {
        var handler = this.getConsoleHandler(context, win);
        if (handler)
        {
            handler.detach();
            Arr.remove(context.activeConsoleHandlers, handler);
        }
    },

    setConsoleHandler: function(context, win, handler)
    {
        if (!context.activeConsoleHandlers)
            context.activeConsoleHandlers = [];

        context.activeConsoleHandlers.push(handler);

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector addConsoleListener set token "+handler.token+
                " and  attached handler("+handler.handler_name+") to _firebugConsole in : "+
                Win.safeGetWindowLocation(win));
    },

    detachConsole: function(context, win)
    {
        if (!win)
            win = context.window;

        this.removeConsoleHandler(context, win);
    },
}

// ********************************************************************************************* //

var total_handlers = 0;
function createConsoleHandler(context, win)
{
    var handler = {};
    handler.console = Firebug.Console.createConsole(context, win),

    handler.detach = function()
    {
        win.document.removeEventListener('firebugAppendConsole', this.boundHandler, true);

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector FirebugConsoleHandler removeEventListener "+
                this.handler_name);
    };

    handler.handler_name = ++total_handlers;
    handler.token = Math.random();

    handler.handleEvent = function(event)
    {
        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("FirebugConsoleHandler("+this.handler_name+") "+
                win.document.getUserData("firebug-methodName")+", event", event);

        if (!Firebug.CommandLine.CommandHandler.handle(event, this.console, win))
        {
            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("FirebugConsoleHandler", this);

            var methodName = win.document.getUserData("firebug-methodName");
            Firebug.Console.log(Locale.$STRF("console.MethodNotSupported", [methodName]));
        }
    };

    handler.setEvaluatedCallback = function( fnOfResult )
    {
        this.console.evaluated = fnOfResult;
    };

    handler.setEvaluateErrorCallback = function( fnOfResultAndContext )
    {
        this.console.evaluateError = fnOfResultAndContext;
    };

    handler.win = win;
    handler.context = context;

    // When raised on our injected element, callback to Firebug and append to console
    handler.boundHandler = Obj.bind(handler.handleEvent, handler);
    win.document.addEventListener('firebugAppendConsole', handler.boundHandler, true); // capturing

    if (FBTrace.DBG_CONSOLE)
        FBTrace.sysout("consoleInjector FirebugConsoleHandler addEventListener "+
            handler.handler_name);

    return handler;
}

// ********************************************************************************************* //

Firebug.Console.createConsole = function createConsole(context, win)
{
    var console = {};
    console.log = function()
    {
        return logFormatted(arguments, "log");
    };

    console.debug = function()
    {
        return logFormatted(arguments, "debug", true);
    };

    console.info = function()
    {
        return logFormatted(arguments, "info", true);
    };

    console.warn = function()
    {
        return logFormatted(arguments, "warn", true);
    };

    console.error = function()
    {
        if (arguments.length == 1)
        {
            return logAssert("error", arguments);  // add more info based on stack trace
        }
        else
        {
            Firebug.Errors.increaseCount(context);
            return logFormatted(arguments, "error", true);  // user already added info
        }
    };

    console.exception = function()
    {
        return logAssert("error", arguments);
    };

    console.assert = function(x)
    {
        if (!x)
        {
            var rest = [];
            for (var i = 1; i < arguments.length; i++)
                rest.push(arguments[i]);
            return logAssert("assert", rest);
        }
        return "_firebugIgnore";
    };

    console.dir = function(o)
    {
        Firebug.Console.log(o, context, "dir", Firebug.DOMPanel.DirTable);
        return "_firebugIgnore";
    };

    console.dirxml = function(o)
    {
        if (o instanceof window.Window)
            o = o.document.documentElement;
        else if (o instanceof window.Document)
            o = o.documentElement;

        Firebug.Console.log(o, context, "dirxml", Firebug.HTMLPanel.SoloElement);
        return "_firebugIgnore";
    };

    console.group = function()
    {
        var sourceLink = getStackLink();
        Firebug.Console.openGroup(arguments, null, "group", null, false, sourceLink);
        return "_firebugIgnore";
    };

    console.groupEnd = function()
    {
        Firebug.Console.closeGroup(context);
        return "_firebugIgnore";
    };

    console.groupCollapsed = function()
    {
        var sourceLink = getStackLink();

        // noThrottle true can't be used here (in order to get the result row now)
        // because there can be some logs delayed in the queue and they would end up
        // in a different grup.
        // Use rather a different method that causes auto collapsing of the group
        // when it's created.
        Firebug.Console.openCollapsedGroup(arguments, null, "group", null, false, sourceLink);
        return "_firebugIgnore";
    };

    console.profile = function(title)
    {
        Firebug.Profiler.startProfiling(context, title);
        return "_firebugIgnore";
    };

    console.profileEnd = function()
    {
        Firebug.Profiler.stopProfiling(context);
        return "_firebugIgnore";
    };

    console.count = function(key)
    {
        var frameId = StackFrame.getStackFrameId();
        if (frameId)
        {
            if (!context.frameCounters)
                context.frameCounters = {};

            if (key != undefined)
                frameId += key;

            var frameCounter = context.frameCounters[frameId];
            if (!frameCounter)
            {
                var logRow = logFormatted(["0"], null, true, true);

                frameCounter = {logRow: logRow, count: 1};
                context.frameCounters[frameId] = frameCounter;
            }
            else
                ++frameCounter.count;

            var label = key == undefined
                ? frameCounter.count
                : key + " " + frameCounter.count;

            frameCounter.logRow.firstChild.firstChild.nodeValue = label;
        }
        return "_firebugIgnore";
    };

    console.clear = function()
    {
        Firebug.Console.clear(context);
        return "_firebugIgnore";
    };

    console.time = function(name, reset)
    {
        if (!name)
            return "_firebugIgnore";

        var time = new Date().getTime();

        if (!this.timeCounters)
            this.timeCounters = {};

        var key = "KEY"+name.toString();

        if (!reset && this.timeCounters[key])
            return "_firebugIgnore";

        this.timeCounters[key] = time;
        return "_firebugIgnore";
    };

    console.timeEnd = function(name)
    {
        var time = new Date().getTime();

        if (!this.timeCounters)
            return "_firebugIgnore";

        var key = "KEY"+name.toString();

        var timeCounter = this.timeCounters[key];
        if (timeCounter)
        {
            var diff = time - timeCounter;
            var label = name + ": " + diff + "ms";

            this.info(label);

            delete this.timeCounters[key];
        }
        return diff;
    };

    console.table = function(data, columns)
    {
        FirebugReps.Table.log(data, columns, context);
        return "_firebugIgnore";
    };

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // These functions are over-ridden by commandLine

    console.evaluated = function(result, context)
    {
        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector.FirebugConsoleHandler evalutated default called", result);

        Firebug.Console.log(result, context);
    };

    console.evaluateError = function(result, context)
    {
        Firebug.Console.log(result, context, "errorMessage");
    };

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    function logFormatted(args, className, linkToSource, noThrottle)
    {
        var sourceLink = linkToSource ? getStackLink() : null;
        var rc = Firebug.Console.logFormatted(args, context, className, noThrottle, sourceLink);
        return rc ? rc : "_firebugIgnore";
    }

    function logAssert(category, args)
    {
        Firebug.Errors.increaseCount(context);

        if (!args || !args.length || args.length == 0)
            var msg = [Locale.$STR("Assertion")];
        else
            var msg = args[0];

        if (msg.stack)
        {
            var trace = StackFrame.parseToStackTrace(msg.stack, context);
            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("logAssert trace from msg.stack", trace);
        }
        else if (context.stackTrace)
        {
            var trace = context.stackTrace
            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("logAssert trace from context.window.stackTrace", trace);
        }
        else
        {
            var trace = getJSDUserStack();
            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("logAssert trace from getJSDUserStack", trace);
        }

        trace = StackFrame.cleanStackTraceOfFirebug(trace);

        var url = msg.fileName ? msg.fileName : win.location.href;
        var lineNo = (trace && msg.lineNumber) ? msg.lineNumber : 0; // we may have only the line popped above
        var errorObject = new FirebugReps.ErrorMessageObj(msg, url, lineNo, "", category, context, trace);

        if (trace && trace.frames && trace.frames[0])
           errorObject.correctWithStackTrace(trace);

        errorObject.resetSource();

        if (args.length > 1)
        {
            errorObject.objects = []
            for (var i = 1; i < args.length; i++)
                errorObject.objects.push(args[i]);
        }

        var row = Firebug.Console.log(errorObject, context, "errorMessage");
        if (row)
            row.scrollIntoView();

        return "_firebugIgnore";
    }

    function getComponentsStackDump()
    {
        // Starting with our stack, walk back to the user-level code
        var frame = Components.stack;
        var userURL = win.location.href.toString();

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector.getComponentsStackDump initial stack for userURL "+
                userURL, frame);

        // Drop frames until we get into user code.
        while (frame && Url.isSystemURL(frame.filename) )
            frame = frame.caller;

        // Drop two more frames, the injected console function and firebugAppendConsole()
        if (frame)
            frame = frame.caller;
        if (frame)
            frame = frame.caller;

        if (FBTrace.DBG_CONSOLE)
            FBTrace.sysout("consoleInjector.getComponentsStackDump final stack for userURL "+
                userURL, frame);

        return frame;
    }

    function getStackLink()
    {
        return StackFrame.getFrameSourceLink(getComponentsStackDump());
    }

    function getJSDUserStack()
    {
        var trace = Firebug.Debugger.getCurrentStackTrace(context);

        var frames = trace ? trace.frames : null;
        if (frames && (frames.length > 0) )
        {
            var oldest = frames.length - 1;  // 6 - 1 = 5
            for (var i = 0; i < frames.length; i++)
            {
                if (frames[oldest - i].href.indexOf("chrome:") == 0)
                    break;

                // firebug-service scope reached, in some cases the url starts with file://
                if (frames[oldest - i].href.indexOf("modules/firebug-service.js") != -1)
                    break;

                // command line
                var fn = frames[oldest - i].getFunctionName() + "";
                if (fn && (fn.indexOf("_firebugEvalEvent") != -1))
                    break;
            }

            // take the oldest frames, leave 2 behind they are injection code
            trace.frames = trace.frames.slice(2 - i);

            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("consoleInjector getJSDUserStack: "+frames.length+" oldest: "+
                    oldest+" i: "+i+" i - oldest + 2: "+(i - oldest + 2), trace.toString().split('\n'));

            return trace;
        }
        else
        {
            return "Firebug failed to get stack trace with any frames";
        }
    }

    return console;
}

// ********************************************************************************************* //
// Registration

return Firebug.Console.injector;

// ********************************************************************************************* //
});
