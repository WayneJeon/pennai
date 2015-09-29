/* Modules */
require("dotenv").config({silent: true}); // Load configuration variables
var os = require("os");
var fs = require("mz/fs");
var spawn= require("child_process").spawn;
var spawnSync = require("child_process").spawnSync;
var http = require("http");
var url = require("url");
var bytes = require("bytes");
var express = require("express");
var bodyParser = require("body-parser");
var morgan = require("morgan");
var rp = require("request-promise");

/* App instantiation */
var app = express();
var jsonParser = bodyParser.json({limit: "50mb"}); // Parses application/json
app.use(morgan("tiny")); // Log requests

// Variables
var specs = {};
var projects = {};
var experiments = {};

/* FGLab check */
if (!process.env.FGLAB_URL) {
  console.log("Error: No FGLab address specified");
  process.exit(1);
}

/* Machine specifications */
// Attempt to read existing specs
fs.readFile("specs.json", "utf-8")
.then(function(sp) {
  specs = JSON.parse(sp);
})
.catch(function() {
  specs = {
    address: process.env.FGMACHINE_URL,
    hostname: os.hostname(),
    os: {
      type: os.type(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release()
    },
    cpus: os.cpus().map(function(cpu) {return cpu.model;}),
    mem: bytes(os.totalmem()),
    gpus: []
  };
  // GPU models
  if (os.platform() === 'linux') {
    var lspci = spawnSync("lspci", []);
    var grep = spawnSync("grep", ["-i", "vga"], {input: lspci.stdout});
    var gpuStrings = grep.stdout.toString().split("\n");
    for (var i = 0; i < gpuStrings.length - 1; i++) {
      specs.gpus.push(gpuStrings[i].replace(/.*controller: /g, ""));
    }
  }

  // Register details
  rp({uri: process.env.FGLAB_URL + "/api/machines", method: "POST", json: specs, gzip: true})
  .then(function(body) {
    console.log("Registered with FGLab successfully");
    // Save ID and specs
    fs.writeFile("specs.json", JSON.stringify(body));
    // Reload specs with _id
    specs = body;
  })
  .catch(function(err) {
    console.log(err);
  });
});

/* Project specifications */
// Attempt to read existing projects
fs.readFile("projects.json", "utf-8")
.then(function(proj) {
  projects = JSON.parse(proj || "{}");
})
.catch(function() {
  projects = {};
});

/* Global max capacity */
var maxCapacity = 1;

var getCapacity = function(projId) {
  var capacity = 0;
  if (projects[projId]) {
    capacity = Math.floor(maxCapacity / projects[projId].capacity);
  }
  return capacity;
};

/* Routes */
// Checks capacity
app.get("/projects/:id/capacity", function(req, res) {
  var capacity = getCapacity(req.params.id);
  if (capacity === 0) {
    res.status(501);
    res.send("Error: No capacity available");
  } else {
    res.send({capacity: capacity, address: specs.address, _id: specs._id});
  }
});

// Starts experiment
app.post("/projects/:id", jsonParser, function(req, res) {
  // Check if capacity still available
  if (getCapacity(req.params.id) === 0) {
    res.status(501);
    return res.send("Error: No capacity available");
  }

  // Process args
  var experimentId = req.body._id;
  var project = projects[req.params.id];
  var args = [];
  for (var i = 0; i < project.args.length; i++) {
    args.push(project.args[i]);
  }
  var hyperparams = req.body;
  // Command-line parsing
  for (var prop in hyperparams) {
    if (project.options === "plain") {
      args.push(prop);
      args.push(hyperparams[prop]);
    } else if (project.options === "single-dash") {
      args.push("-" + prop);
      args.push(hyperparams[prop]);
    } else if (project.options === "double-dash") {
      args.push("--" + prop + "=" + hyperparams[prop]);
    }
  }

  // Spawn experiment
  var experiment = spawn(project.command, args, {cwd: project.cwd});
  maxCapacity -= project.capacity; // Reduce capacity of machine
  rp({uri: process.env.FGLAB_URL + "/api/experiments/" + experimentId + "/started", method: "PUT", data: null}); // Set started

  // Save experiment
  experiments[experimentId] = experiment;

  // Log stdout
  experiment.stdout.on("data", function(data) {
    console.log(data.toString());
  });

  // Log errors
  experiment.stderr.on("data", function(data) {
    console.log("Error: " + data.toString());
  });

  // Processes results
  experiment.on("exit", function(exitCode) {
    maxCapacity += project.capacity; // Add back capacity

    // Results-sending function
    var sendResults = function(results) {
      rp({uri: process.env.FGLAB_URL + "/api/experiments/" + experimentId, method: "PUT", json: JSON.parse(results), gzip: true});
    };

    // Send all result files
    var resultsDir = project.results + "/" + experimentId;
    fs.readdir(resultsDir)
    .then(function(files) {
      for (var i = 0; i < files.length; i++) {
        if (files[i].match(/\.json$/)) { // Only pass JSON files
          fs.readFile(resultsDir + "/" + files[i], "utf-8").then(sendResults);
        }
      }
    });

    // Send status
    var status = (exitCode === 0) ? "success" : "fail";
    rp({uri: process.env.FGLAB_URL + "/api/experiments/" + experimentId, method: "PUT", json: {_status: status}, gzip: true});
    rp({uri: process.env.FGLAB_URL + "/api/experiments/" + experimentId + "/finished", method: "PUT", data: null}); // Set finished

    // Delete experiment
    delete experiments[experimentId];
  });
  res.send(req.body);
});

// Kills experiment
app.post("/experiments/:id/kill", function(req, res) {
  if (experiments[req.params.id]) {
    experiments[req.params.id].kill();
  }
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow CORS
  res.send(JSON.stringify({status: "killed"}));
});

/* HTTP Server */
var server = http.createServer(app); // Create HTTP server
if (!process.env.FGMACHINE_URL) {
  console.log("Error: No FGMachine address specified");
  process.exit(1);
} else {
  // Listen for connections
  var port = url.parse(process.env.FGMACHINE_URL).port;
  server.listen(port, function() {
    console.log("Server listening on port " + port);
  });
}
