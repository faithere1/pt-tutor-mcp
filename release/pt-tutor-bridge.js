// PT Tutor bridge — runs inside Packet Tracer's Script Engine.
//
// Transport: a file mailbox, no network socket. The MCP server drops
// req_<id>.json into the mailbox; we run the named command and answer with
// res_<id>.json. Only commands in COMMANDS can run. Raw JavaScript is
// accepted only when PT_TUTOR_DEV is true.

var PT_TUTOR_VERSION = "0.1.1";
var PT_TUTOR_DEV = false;         // release build: eval and reload are disabled
var POLL_IDLE_MS = 250;
var POLL_BUSY_MS = 30;
var STALE_REQUEST_S = 60;

var _timer = null;
var _mailbox = null;

// Device::getType() values, from the IPC API reference.
var DEVICE_TYPES = [
    "Router", "Switch", "Cloud", "Bridge", "Hub", "Repeater", "CoAxialSplitter",
    "AccessPoint", "PC", "Server", "Printer", "WirelessRouter", "IpPhone",
    "DslModem", "CableModem", "RemoteNetwork", "MultiLayerSwitch", "Switch3650",
    "Laptop", "TabletPC", "Pda", "WirelessEndDevice", "WiredEndDevice", "TV",
    "HomeVoip", "AnalogPhone", "MultiUser", "ASA", "IoE", "HomeGateway",
    "WirelessRouterNewGeneration", "CellTower", "CentralOfficeServer",
    "CiscoAccessPoint", "EmbeddedCiscoAccessPoint", "Sniffer", "MCU", "SBC",
    "Thing", "MCUComponent", "EmbeddedServer", "WirelessLanController", "Cluster",
    "GeoIcon", "LightWeightAccessPoint", "PowerDistributionDevice", "PatchPanel",
    "WallMount", "SecurityAppliance", "MerakiServer", "NetworkController", "PLC"
];

// Canvas furniture that is not part of the network a student reasons about.
var NON_NETWORK_TYPES = { Cluster: 1, GeoIcon: 1, PowerDistributionDevice: 1, PatchPanel: 1, WallMount: 1 };

// Devices whose CLI is Cisco IOS (as opposed to a PC's "C:\>" prompt).
var IOS_TYPES = { Router: 1, Switch: 1, MultiLayerSwitch: 1, Switch3650: 1, ASA: 1 };

function mailboxDir() {
    // getUserFolder() is "<home>/Cisco Packet Tracer 9.0.0"; the mailbox sits
    // next to it at <home>/.pt-tutor/mailbox (created by the MCP server).
    var uf = String(ipc.appWindow().getUserFolder()).replace(/\\/g, "/");
    return uf.substring(0, uf.lastIndexOf("/")) + "/.pt-tutor/mailbox";
}

function writeAtomic(fm, path, text) {
    fm.writePlainTextToFile(path + ".tmp", text);
    fm.moveSrcFileToDestFile(path + ".tmp", path, true);
}

function reply(id, payload) {
    var fm = ipc.systemFileManager();
    writeAtomic(fm, _mailbox + "/res_" + id + ".json", JSON.stringify(payload));
}

function typeName(device) {
    return DEVICE_TYPES[Number(device.getType())] || ("Unknown" + Number(device.getType()));
}

function getDevice(name) {
    var d = ipc.network().getDevice(name);
    if (!d) throw new Error("no such device: " + name);
    return d;
}

function describePort(p, detailed) {
    var port = { name: String(p.getName()) };
    try { port.up = !!p.isPortUp(); port.protocolUp = !!p.isProtocolUp(); } catch (e) {}
    try {
        var ip = String(p.getIpAddress());
        if (ip && ip !== "0.0.0.0") { port.ip = ip; port.mask = String(p.getSubnetMask()); }
    } catch (e) {}
    try {
        // Link has getPort1()/getPort2(); the getOtherPortConnectedTo() in
        // the API docs' example does not exist in PT 9.
        var link = p.getLink();
        if (link) {
            var p1 = link.getPort1(), p2 = link.getPort2();
            var mine = String(p.getOwnerDevice().getName()) + "|" + port.name;
            var other = String(p1.getOwnerDevice().getName()) + "|" + String(p1.getName()) === mine ? p2 : p1;
            port.connectedTo = { device: String(other.getOwnerDevice().getName()), port: String(other.getName()) };
        }
    } catch (e) {}
    if (detailed) {
        try { port.mac = String(p.getMacAddress()); } catch (e) {}
        try { port.description = String(p.getDescription()); } catch (e) {}
        try { port.dhcp = !!p.isDhcpClientOn(); } catch (e) {}
        try { port.adminUp = !!p.getPower(); } catch (e) {}
    }
    return port;
}

function describeDevice(d, detailed) {
    var ports = [];
    var pc = d.getPortCount();
    for (var j = 0; j < pc; j++) ports.push(describePort(d.getPortAt(j), detailed));
    return {
        name: String(d.getName()),
        type: typeName(d),
        model: String(d.getModel()),
        power: !!d.getPower(),
        ports: ports
    };
}

// ---------------------------------------------------------------- CLI
//
// Commands are queued per device so concurrent requests never interleave on
// one terminal. Output is collected from the outputWritten event until the
// prompt comes back and the terminal has been quiet for a moment.

var _cliQueues = {};

function enqueueCli(deviceName, job) {
    var q = _cliQueues[deviceName] || (_cliQueues[deviceName] = []);
    q.push(job);
    if (q.length === 1) job();
}

function cliJobDone(deviceName) {
    var q = _cliQueues[deviceName];
    q.shift();
    if (q.length) q[0]();
}

function runCli(d, command, opts, done, fail) {
    var line = d.getCommandLine();
    if (!line) throw new Error("device has no command line: " + d.getName());
    var isIos = !!IOS_TYPES[typeName(d)];
    var timeoutMs = opts.timeoutMs || 15000;
    var quietMs = opts.quietMs || 300;
    var notes = [];

    var out = "";
    var lastAt = Date.now();
    var handler = function (src, ev) { out += String(ev.newOutput); lastAt = Date.now(); };
    line.registerEvent("outputWritten", null, handler);

    function finish(err, value) {
        try { line.unregisterEvent("outputWritten", null, handler); } catch (e) {}
        if (err) fail(err); else done(value);
    }

    // Phase 1: get past boot dialogs to a usable prompt.
    var prepSteps = 0;
    function prepare() {
        var prompt = String(line.getPrompt());
        if (prepSteps++ > 8) return finish(new Error("terminal not ready, prompt: " + prompt));
        if (/initial configuration dialog/i.test(prompt)) {
            line.enterCommand("no");
            notes.push("answered 'no' to the initial configuration dialog");
            return setTimeout(prepare, 400);
        }
        if (prompt.replace(/\s/g, "") === "") {
            line.enterCommand("");
            return setTimeout(prepare, 300);
        }
        if (isIos) return elevate();
        return send(command);
    }

    // Phase 2 (IOS): show commands need privileged mode; in config modes they
    // need a "do" prefix.
    function elevate() {
        var mode = String(line.getMode());
        if (mode === "user" && opts.privileged !== false) {
            line.enterCommand("enable");
            return setTimeout(function () {
                var prompt = String(line.getPrompt());
                if (/password/i.test(prompt)) {
                    // Do not guess passwords: back out and stay in user mode.
                    line.enterCommand(""); line.enterCommand(""); line.enterCommand("");
                    notes.push("enable password is set; ran in user EXEC mode");
                }
                setTimeout(sendInMode, 200);
            }, 300);
        }
        sendInMode();
    }

    function sendInMode() {
        var mode = String(line.getMode());
        var prefix = (mode === "user" || mode === "enable") ? "" : "do ";
        if (prefix) notes.push("terminal was in '" + mode + "' mode; used 'do'");
        send(prefix + command);
    }

    // Phase 3: run the command and wait for the prompt to return.
    function send(cmd) {
        out = "";
        lastAt = Date.now();
        var started = Date.now();
        line.enterCommand(cmd);
        function check() {
            var now = Date.now();
            // "terminal length 0" is not honoured everywhere (and PCs page
            // too), so press space at each --More--.
            if (/--More--\s*$/.test(out)) {
                line.enterChar(32, 0);
                lastAt = now;
                return setTimeout(check, 100);
            }
            var prompt = String(line.getPrompt());
            var settled = now - lastAt >= quietMs && out.replace(/\s+$/, "").slice(-prompt.length) === prompt.replace(/\s+$/, "");
            if (settled || now - started > timeoutMs) {
                finish(null, {
                    command: cmd,
                    output: cleanOutput(out, cmd, prompt),
                    prompt: prompt,
                    mode: String(line.getMode()),
                    timedOut: !settled,
                    notes: notes
                });
            } else {
                setTimeout(check, 100);
            }
        }
        setTimeout(check, 100);
    }

    prepare();
}

// Drops the echoed command line and the trailing prompt.
function cleanOutput(out, cmd, prompt) {
    var text = out.replace(/\r/g, "").replace(/ ?--More-- ?/g, "");
    var echo = text.indexOf(cmd);
    if (echo !== -1 && echo < 80) text = text.substring(echo + cmd.length);
    text = text.replace(/\s+$/, "");
    var p = prompt.replace(/\s+$/, "");
    if (p && text.slice(-p.length) === p) text = text.substring(0, text.length - p.length);
    return text.replace(/^\n+/, "").replace(/\s+$/, "");
}

// ---------------------------------------------------------------- commands
// Each command is function(args, done, fail). Call done(value), call
// fail(error) or throw.

var COMMANDS = {};

COMMANDS.ping = function (args, done) {
    var file = ipc.appWindow().getActiveFile();
    done({
        bridge: PT_TUTOR_VERSION,
        pt: String(ipc.appWindow().getVersion()),
        dev: PT_TUTOR_DEV,
        file: String(file.getSavedFilename())
    });
};

COMMANDS.activityStatus = function (args, done) {
    var file = ipc.appWindow().getActiveFile();
    var out = { isActivityFile: !!file.isActivityFile(), file: String(file.getSavedFilename()) };
    if (out.isActivityFile) {
        try { out.percentComplete = Number(file.getPercentageComplete()); } catch (e) {}
        try { out.timeLeft = Number(file.getCountDownTimeLeft()); } catch (e) {}
    }
    done(out);
};

COMMANDS.topology = function (args, done) {
    var net = ipc.network();
    var devices = [];
    var links = [];
    var seen = {};
    var count = net.getDeviceCount();
    for (var i = 0; i < count; i++) {
        var d = net.getDeviceAt(i);
        if (!args.all && NON_NETWORK_TYPES[typeName(d)]) continue;
        var info = describeDevice(d, false);
        for (var j = 0; j < info.ports.length; j++) {
            var p = info.ports[j];
            if (!p.connectedTo) continue;
            var a = info.name + ":" + p.name, b = p.connectedTo.device + ":" + p.connectedTo.port;
            var key = a < b ? a + "|" + b : b + "|" + a;
            if (seen[key]) continue;
            seen[key] = true;
            links.push({ a: { device: info.name, port: p.name }, b: p.connectedTo, up: !!(p.up && p.protocolUp) });
        }
        // The summary lists only ports that are cabled or addressed.
        info.ports = info.ports.filter(function (p) { return p.connectedTo || p.ip; });
        devices.push(info);
    }
    done({ devices: devices, links: links });
};

COMMANDS.deviceState = function (args, done) {
    done(describeDevice(getDevice(args.device), true));
};

COMMANDS.cli = function (args, done, fail) {
    var d = getDevice(args.device);
    var name = String(d.getName());
    enqueueCli(name, function () {
        var release = function () { cliJobDone(name); };
        try {
            runCli(d, args.command, args,
                function (v) { release(); done(v); },
                function (e) { release(); fail(e); });
        } catch (e) {
            release();
            fail(e);
        }
    });
};

COMMANDS.eval = function (args, done) {
    if (!PT_TUTOR_DEV) throw new Error("eval is disabled");
    var v = eval(args.code);
    done(v === undefined ? null : JSON.parse(JSON.stringify(v)));
};

// Dev only: re-evaluates bridge.js from disk so edits apply without the user
// stopping and starting the module. Runs after the reply is written.
COMMANDS.reload = function (args, done) {
    if (!PT_TUTOR_DEV) throw new Error("reload is disabled");
    var src = String(ipc.systemFileManager().getFileContents(args.path));
    if (src.indexOf("PT_TUTOR_VERSION") === -1) throw new Error("not a bridge source: " + args.path);
    done("reloading");
    setTimeout(function () {
        cleanUp();
        (0, eval)(src);
        main();
    }, 50);
};

// ---------------------------------------------------------------- mailbox loop

function handle(fm, file) {
    var path = _mailbox + "/" + file;
    var req;
    try { req = JSON.parse(String(fm.getFileContents(path))); } catch (e) { req = null; }
    fm.removeFile(path);
    if (!req || !req.id) return;

    var fn = COMMANDS[req.cmd];
    if (!fn) { reply(req.id, { ok: false, error: "unknown command: " + req.cmd }); return; }
    var answered = false;
    var done = function (value) { if (!answered) { answered = true; reply(req.id, { ok: true, value: value }); } };
    var fail = function (e) { if (!answered) { answered = true; reply(req.id, { ok: false, error: String(e && e.message || e) }); } };
    try {
        fn(req.args || {}, done, fail);
    } catch (e) {
        fail(e);
    }
}

function tick() {
    var busy = false;
    try {
        var fm = ipc.systemFileManager();
        if (fm.directoryExists(_mailbox)) {
            fm.writePlainTextToFile(_mailbox + "/heartbeat", String(Date.now()));
            var now = Math.floor(Date.now() / 1000);
            var files = fm.getFilesInDirectory(_mailbox);
            for (var i = 0; i < files.length; i++) {
                var f = String(files[i]);
                var isReq = f.indexOf("req_") === 0, isRes = f.indexOf("res_") === 0;
                if (!isReq && !isRes) continue;
                // Requests nobody picked up and replies nobody collected
                // (the caller timed out) are dropped after a while.
                if (now - fm.getFileModificationTime(_mailbox + "/" + f) > STALE_REQUEST_S) {
                    fm.removeFile(_mailbox + "/" + f);
                    continue;
                }
                if (!isReq || f.slice(-5) !== ".json") continue;
                handle(fm, f);
                busy = true;
            }
        }
    } catch (e) {
        dprint("pt-tutor tick error: " + e);
    }
    _timer = setTimeout(tick, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
}

function main() {
    _mailbox = mailboxDir();
    dprint("pt-tutor bridge " + PT_TUTOR_VERSION + " watching " + _mailbox);
    tick();
}

function cleanUp() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
}
