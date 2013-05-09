var spawn = require("child_process").spawn;
var exec = require("child_process").exec;
var async = require("async");
var path = require("path");
var semver = require("semver");
var rsync = require("rsyncwrapper").rsync;
var _ = require("underscore");
var S = require("string");

module.exports = function (grunt) {

    grunt.registerMultiTask("herunt","Deploy to Heroku",function () {

        var done = this.async();

        var src = path.resolve(this.data.src);
        var dest = path.resolve(this.data.dest);
        var newAppRegion = this.data.newAppRegion;
        var exclude = this.data.exclude||[];

        src = src.charAt(src.length-1) === "/" ? src.slice(0,-1) : src;
        dest = dest.charAt(dest.length-1) === "/" ? dest.slice(0,-1) : dest;

        grunt.log.writelns("Using src folder "+src.cyan);
        grunt.log.writelns("Deploying from app folder "+dest.cyan);

        var initialTasks = [
            checkHerokuCLIPresent,
            checkHerokuCLIVersion,
            checkHerokuCLIAuth,
            checkSrc,
            checkDest,
            checkDestGit,
            checkDestHeroku,
            pull,
            syncSrcToDest,
            touchDeploymentInfoFile,
            addAndCommit,
            push
        ];

        async.series(initialTasks,function (err) {
            if ( err ) {
                grunt.log.error();
                grunt.log.errorlns(err);
                done(false);
            } else {
                done(true);
            }
        });

        function checkHerokuCLIPresent (cb) {
            grunt.log.write("Checking for the Heroku CLI tool ");
            exec("which heroku",function (err,stdout,stderr) {
                if ( err ) {
                    cb("Unable to invoke the Heroku CLI tool. Is it installed? "+stderr);
                } else {
                    grunt.log.ok();
                    cb();
                }
            });
        }

        function checkHerokuCLIVersion (cb) {
            grunt.log.write("Checking Heroku CLI tool version ");
            exec("heroku --version",function (err,stdout,stderr) {
                if ( err || !stdout || stdout === "" ) {
                    cb("Unable to check the Heroku CLI tool version. "+stderr);
                } else {
                    var installedVersion = stdout.split(" ")[0].split("/")[1];
                    var minVersion = "2.39.2";
                    if ( semver.gte(installedVersion,minVersion) ) {
                        grunt.log.ok();
                        cb();
                    } else {
                        cb("The installed Heroku CLI tool is out of date. Version "+minVersion+" and above is required.");
                    }
                }
            });
        }

        function checkHerokuCLIAuth (cb) {
            grunt.log.write("Checking Heroku CLI tool auth status ");
            exec("cat ~/.netrc",function (err,stdout,stderr) {
                if ( err ) {
                    cb("Can't read the ~/.netrc file. Unable to determine auth status. "+stderr);
                } else {
                    if ( stdout.indexOf("code.heroku.com") > -1 ) {
                        grunt.log.ok();
                        cb();
                    } else {
                        cb("You don't appear to be authenticated. Try running 'heroku login'.");
                    }
                }
            });
        }

        function checkSrc (cb) {
            grunt.log.write("Checking the src folder ");
            var isDir = grunt.file.isDir(src);
            if ( !isDir ) {
                cb("The src folder doesn't seem to be pointing at a valid location.");
                return;
            }
            var hasPackageJSON = grunt.file.exists(src+"/package.json");
            if ( !hasPackageJSON ) {
                cb("The src folder doesn't contain a package.json, is it a Node app?");
                return;
            }
            var hasProcfile = grunt.file.exists(src+"/Procfile");
            if ( !hasProcfile ) {
                cb("The src folder doesn't contain a Procile, is it ready for Heroku deployment?");
                return;
            }
            grunt.log.ok();
            cb();
        }

        function checkDest (cb) {
            var isDir = grunt.file.isDir(dest);
            if ( isDir ) {
                grunt.log.write("Checking the dest folder ");
            } else {
                grunt.log.write("Dest folder not present, creating ");
                grunt.file.mkdir(dest);
            }
            grunt.log.ok();
            cb();
        }

        function checkDestGit (cb) {
            exec("git rev-parse --show-toplevel",{cwd:dest},function (err,stdout,stderr) {
                if ( S(dest).trim().s!==S(stdout).trim().s ) {
                    grunt.log.write("Dest folder isn't a Git repo root, setting it up ");
                    exec("git init; git add .; git commit -m \"Initial commit.\"",{cwd:dest},function (err,stdout,stderr) {
                        grunt.log.ok();
                        cb();
                    });
                } else {
                    grunt.log.write("Dest folder Git check ");
                    grunt.log.ok();
                    cb();
                }
            });
        }

        function checkDestHeroku (cb) {
            var appName;
            exec("heroku info",{cwd:dest},function (err,stdout,stderr) {
                if ( err ) {
                    grunt.log.write("No Heroku app found in dest, created ");
                    var cmd = "heroku create";
                    if ( newAppRegion ) cmd = cmd+" --region "+newAppRegion;
                    exec(cmd,{cwd:dest},function (err,stdout,stderr) {
                        if ( err ) {
                            cb("Unable to create the Heroku app. "+stderr);
                        } else {
                            var appName = stdout.split("Creating ")[1].split("... ")[0];
                            grunt.log.write(appName.cyan+" ");
                            grunt.log.ok();
                            cb();
                        }
                    });
                } else {
                    stdout = stdout||"";
                    var appName = stdout.split("\n")[0].split("=== ")[1]||"[unknown app]";
                    grunt.log.write("Found Heroku app in dest "+appName.cyan+" ");
                    grunt.log.ok();
                    cb();
                }
            });
        }

        function pull (cb) {
            grunt.log.write("Pulling latest app changes from Heroku, if any ");
            exec("git branch -av",{cwd:dest},function (err,stdout,stderr) {
                if ( err ) {
                    cb("Unable to determine repo status. "+stderr);
                } else {
                    if ( stdout === "" ) {
                        grunt.log.ok();
                        cb();
                    } else {
                        exec("git pull heroku master",{cwd:dest},function (err,stdout,stderr) {
                            if ( err ) {
                                cb("Can't pull from Heroku. "+stderr);
                            } else {
                                grunt.log.ok();
                                cb();
                            }
                        });
                    }
                }
            });

        }

        function syncSrcToDest (cb) {
            grunt.log.write("Syncing src files to dest ");
            rsync({
                src: src+"/",
                dest: dest,
                recursive: true,
                exclude: _.union(exclude,[".DS_Store","node_modules",".git",".gitignore",".nodemonignore","npm-debug.log"]),
                args: ["--delete"]
            }, function (err,stdout,stderr,cmd) {
                if ( err) {
                    cb("Unable to sync src files to dest. "+stderr);
                } else {
                    grunt.log.ok();
                    cb();
                }
            });
        }

        function touchDeploymentInfoFile (cb) {
            var now = new Date().toString();
            var user = process.env.USER || "Anon";
            var infoString = "Deployed by "+user+" at "+now+" using Herunt.";
            grunt.log.write("Touching deployment-info file to ensure a change in Git ");
            exec("touch ./deployment-info; echo \""+infoString+"\" > ./deployment-info",{cwd:dest},function (err,stdout,stderr) {
                if ( err ) {
                    cb("Unable to make the deployment string file. "+stderr);
                } else {
                    grunt.log.ok();
                    cb();
                }
            });
        }

        function addAndCommit (cb) {
            grunt.log.write("Adding and committing new files to the repo ");
            exec("git add -A; git commit -m \"Herunt deployment.\"",{cwd:dest},function (err,stdout,stderr) {
                if ( err ) {
                    cb("Unable to add and commit new files in dest. "+stderr);
                } else {
                    grunt.log.ok();
                    cb();
                }
            });
        }

        function push (cb) {
            grunt.log.writelns("Deploying to Heroku ...");
            var ps = spawn("git",["push","heroku","master"],{cwd:dest});
            ps.stderr.on("data",function (data) {
                grunt.log.write(data.toString("utf8"));
            });
            ps.stdout.on("data",function (data) {
                grunt.log.write(data.toString("utf8"));
            });
            ps.on("exit",function (code) {
                if ( code > 0 ) {
                    cb("\nError pushing to Heroku git repo.");
                } else {
                    grunt.log.write("\nDeployment completed ");
                    grunt.log.ok();
                    cb();
                }
            });
        }
    });
};