DateRange = Match.Where(function (x) {
    check(x, {gte: Date, lt: Date});
    return (x.gte < x.lt);
});

Day = Match.Where(function (d) {
    return _.contains([0,1,2,3,4,5,6], d);
});

Longitude = Match.Where(function (x) {
    check(x, Number);
    return x >= -180 && x <= 180;
});

Latitude = Match.Where(function (x) {
    check(x, Number);
    return x >= -90 && x <= 90;
});

GeoJSONPolygon = Match.Where(function (x) {
    check(x, {type: String, coordinates: [[[Number]]]});
    return (x.type === "Polygon") &&
        (x.coordinates.length === 1) &&
        _.every(x.coordinates[0], function (coord) {
            check(coord[0], Longitude);
            check(coord[1], Latitude);
            return coord.length === 2;
        });
});

GeoJSONPoint = Match.Where(function (x) {
    check(x, {type: String, coordinates: [Number]});
    check(x.coordinates[0], Longitude);
    check(x.coordinates[1], Latitude);
    return (x.type === "Point") && (x.coordinates.length === 2);
});

GameType = Match.Where(function (x) {
    check(x, String);
    var types = _.pluck(GameOptions.find({option: "type"}).fetch(),
        'value');
    return _.contains(types, x);
});

GameStatus = Match.Where(function (x) {
    check(x, String);
    var statuses = _.pluck(GameOptions.find({option: "status"}).fetch(),
        'value');
    return _.contains(statuses, x);
});

WithinAWeekFromNow = Match.Where(function (x) {
    check(x, Date);
    var then = moment(x);
    var now = moment();
    var aWeekFromNow = moment().add('weeks', 1);
    return now.isBefore(then) && then.isBefore(aWeekFromNow);
});

NonEmptyString = Match.Where(function (x) {
    check(x, String);
    if (x.length === 0)
        throw new Match.Error("Cannot be blank.");
    return true;
});

NonNegativeInteger = Match.Where(function (x) {
    check(x, Match.Integer);
    return x >= 0;
});

var rsvps = ["in"];
Player = Match.Where(function (x) {
    check(x, Match.ObjectIncluding({
        userId: Match.Optional(String),
        friendId: Match.Optional(String),
        name: NonEmptyString,
        rsvp: String}));
    // TODO: require userId or friendId, and lose rsvp throughout code
    // need to update server/bootstrap.js::getNPlayers for this change
    return _.contains(rsvps, x.rsvp);
});

ValidEmail = Match.Where(function (x) {
    check(x, String);
    // Uses RegExp of http://www.w3.org/TR/html-markup/input.email.html
    return /^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(x);
});

ValidPassword =  Match.Where(function (x) {
    check(x, NonEmptyString);
    if (x.length < 6)
        throw new Match.Error("Password must be at least 6 characters.");
    return true;
});

ValidComment = Match.Where(function (x) {
    check(x, {
        userId: String,
        userName: String,
        message: String,
        timestamp: Date
    });
    return true;
});

UTCOffset = Match.Where(function (x) {
    check(x, Number);
    return (x < 16) && (x > -16);
});

ValidGame = {
    //creator: Match.Optional({name: String, userId: String}), <-- not passed in
    //notificationsSent: Match.Optional(Boolean)
    type: GameType,
    status: GameStatus,
    startsAt: WithinAWeekFromNow,
    location: {name: NonEmptyString,
        geoJSON: GeoJSONPoint,
        utc_offset: Match.Optional(UTCOffset)},
    note: String,
    players: [Player],
    comments: [ValidComment],
    requested: Match.ObjectIncluding({players: NonNegativeInteger})
};

maybeMakeGameOn = function (gameId) {
    var game = Games.findOne(gameId);
    if (game.status === "proposed" &&
        (game.players.length >= game.requested.players)) {
        return Games.update(gameId, {$set: {status: "on"}});
    } else {
        // because collection.update returns the number of affected documents
        return 0;
    }
};

Meteor.methods({
    addGame: function (game) {
        var self = this;
        var user = Meteor.users.findOne(self.userId);
        if (!user)
            throw new Meteor.Error(401, "Must be signed in");
        check(game, ValidGame);

        if (game.location.name.length > 100)
            throw new Meteor.Error(413, "Location name too long");
        if (game.note.length > 250)
            throw new Meteor.Error(413, "Game note too long");

        game = _.extend(game, {
            creator: {name: user.profile.name, userId: user._id}
        });
        var result = {gameId: Games.insert(game)};
        Meteor.isServer && gameReminders.scheduleReminderForOrganizer(result.gameId);
        return result;
    },
    editGame: function (id, game) {
        var self = this;
        if (game.requested.players === 0) {
            game.status = "on";
        } else {
            game.status = "proposed";
        }
        check(id, String);
        check(game, ValidGame);

        var oldGame = Games.findOne(id);
        if (! oldGame)
            throw new Meteor.Error(404, "Game not found.");

        var user = Meteor.users.findOne(self.userId);
        if (! user)
            throw new Meteor.Error(401, "Must be signed in.");

        check(user, Match.Where(function (user) {
            return user._id === oldGame.creator.userId || user.admin;
        }));

        if (game.location.name.length > 100)
            throw new Meteor.Error(413, "Location name too long");
        if (game.note.length > 1000)
            throw new Meteor.Error(413, "Game note too long");

        // collect differences between `oldGame` and `game` wrt
        // location, day/time (`startsAt`), organizer's note, and game type (!)
        var changes = {};

        (! EJSON.equals(oldGame.location.geoJSON, game.location.geoJSON)) &&
        _.extend(changes, {location: game.location});

        var oldM = utils.startsAtMomentWithOffset(oldGame);
        var newM = utils.startsAtMomentWithOffset(game);
        oldM.format('ddd') !== newM.format('ddd') &&
        _.extend(changes, {day: newM});
        oldM.format('h:mma') !== newM.format('h:mma') &&
        _.extend(changes, {time: newM});

        oldGame.note !== game.note && _.extend(changes, {note: game.note});
        oldGame.type !== game.type && _.extend(changes, {type: game.type});

        return Games.update(id, {$set: {
            type: game.type,
            status: game.status,
            startsAt: game.startsAt,
            location: game.location,
            note: game.note,
            players: game.players,
            comments: oldGame.comments, // no comment edits
            requested: game.requested
        }}, function (err) {
            if (!err && !_.isEmpty(changes)) {
                Meteor.isServer && notifyPlayers(id, {changes: changes});
                Meteor.isServer && gameReminders.scheduleReminderForOrganizer(id);
            }
        });
    },
    cancelGame: function (id) {
        var self = this;
        check(id, String);

        var game = Games.findOne(id);
        if (!game)
            throw new Meteor.Error(404, "Game not found.");

        var user = Meteor.users.findOne(self.userId);
        if (!user)
            throw new Meteor.Error(401, "Must be signed in.");

        check(user, Match.Where(function (user) {
            return user._id === game.creator.userId || user.admin;
        }));

        if (Meteor.isServer) {
            // Cancels the reminder about the upcoming game.
            // Calling this before e-mails are sent so that they won't
            // receive reminders first and then cancellation e-mails after.
            // However, there is a possibility that the scheduled job just ran before we cancelled,
            // so they might still get both e-mails.
            gameReminders.cancelReminderFromOrganizer(id);

            this.unblock();
            var email;
            _.each(game.players, function (player) {
                if (player.userId && player.userId !== game.creator.userId) {
                    // notify all players other than organizer
                    email = Meteor.users.findOne(player.userId).emails[0];
                    if (email.verified) {
                        sendEmail({
                            from: emailTemplates.from,
                            to: player.name + "<" + email.address + ">",
                            subject: "Game CANCELLED: " + game.type + " " +
                                utils.startsAtMomentWithOffset(game).format('dddd h:mmA') +
                                " at " + game.location.name,
                            text: "Sorry, " + player.name + ".\n" +
                                "This game has been cancelled. [Check out](" +
                                Meteor.absoluteUrl('') + ") other nearby games, or " +
                                "[add](" + Meteor.absoluteUrl('addGame') + ") your own!"
                        });
                    }
                }
            });
        }
        return Games.remove(id);
    },
    addSelf: function (args) {
        this.unblock();
        check(args, {
            gameId: String,
            name: Match.Optional(NonEmptyString)
        });
        var gameId = args.gameId,
            name = args.name;
        var userId = this.userId;
        if (! userId) return false;
        if (Games.findOne({_id: gameId, 'players.userId': userId})) {
            return false;
        } else {
            name = name || Meteor.users.findOne(userId).profile.name;
            var player = {userId: userId, name: name, rsvp: "in"};
            check(player, Player); // name must be non-empty
            Games.update(gameId, {$push: {players: player}});
            maybeMakeGameOn(gameId);
            Meteor.isServer && notifyOrganizer(gameId, {
                joined: {userId: userId, name: name}
            });
            return true;
        }
    },
    editGamePlayer: function (gameId, fields) {
        var self = this;
        check(fields, {oldName: NonEmptyString, newName: NonEmptyString});
        // Minimongo doesn't support use of the `$` field yet.
        // Consider having a separate Players collection.
        if (Meteor.isServer) {
            Games.update({
                _id: gameId,
                "players.userId": self.userId,
                "players.name": fields.oldName
            }, {$set: {"players.$.name": fields.newName}});
        }

        // email taken -> error
        // if (Meteor.users.findOne({'emails.address': email})) {
        //   throw new Meteor.Error(401, "Email already belongs to user");
        // }
    },
    pullPlayer: function (name, gameId) {
        var self = this;
        // If user added two players with same name, both are removed.
        // Note: client UI alerts if name to add is already taken.
        Games.update(gameId, {$pull: {players: {userId: self.userId, name: name}}});
    },
    leaveGame: function (gameId) {
        this.unblock();
        var self = this;
        var game = Games.findOne(gameId);
        if (!game)
            throw new Meteor.Error(404, "Game not found.");
        if (! self.userId)
            throw new Meteor.Error(401, "Must be signed in.");
        Games.update(gameId, {$pull: {players: {userId: self.userId}}});
        var numNonUserFriends = _.filter(game.players, function (p) {
            return p.friendId === self.userId && !p.userId;
        }).length;
        Games.update(gameId, {$pull: {players: {
            friendId: self.userId,
            userId: {$exists: false}
        }}}, function (error, result) {
            // `result` will always return 1, unfortunately, so need
            // to calculate and use `numNonUserFriends`
            if (self.isSimulation && (! error) && numNonUserFriends > 0) {
                Alerts.throw({
                    message: "The friends you added to this game without " +
                        "email addresses have been removed.",
                    type: "warning", where: gameId
                });
            }
            if (! error && Meteor.isServer) {
                var user = Meteor.users.findOne(self.userId);
                var name = user.profile.name || "Someone";
                notifyOrganizer(gameId, {left: {
                    userId: user._id, name: name, numFriends: numNonUserFriends
                }});
            }
        });
    },
    addComment: function (message, gameId) {
        if (! Match.test(message, NonEmptyString)) {
            console.log('message must be non-empty');
            return false;
        }
        if (! gameId) {
            console.log("no gameId provided");
            return false;
        };
        // user may wish to ask about game before joining,
        // so user need not be playing in game.
        var self = this;
        var user = this.userId && Meteor.users.findOne(this.userId);
        if (! user) {
            console.log('sign in first');
            return false;
        }
        var timestamp = new Date();
        Games.update(gameId, {
            $push: {comments: {
                userId: user._id,
                userName: user.profile.name || "Anonymous",
                message: message,
                timestamp: timestamp
            }}
        });
        Meteor.call("notifyCommentListeners", gameId, timestamp);
        return true;
    },
    removeComment: function (comment) {
        var self = this;
        check(comment, Match.Where(function (c) {
            check(_.omit(c, 'gameId'), ValidComment);
            check(c.gameId, String);
            return true;
        }));

        var user = Meteor.users.findOne(self.userId);
        if (! user)
            throw new Meteor.Error(401, "Must be signed in.");

        var game = Games.findOne(comment.gameId);
        if (! game)
            throw new Meteor.Error(400, "Not an active game.");

        if (user._id === comment.userId ||
            user._id === game.creator.userId ||
            user.admin) {
            Games.update(comment.gameId, {
                $pull: {comments: _.omit(comment, 'gameId')}
            });
            return true;
        } else {
            return false;
        }
    },
    sendFeedback: function (options) {
        if (this.isSimulation) {
            Alerts.throw({message: "Thanks!", type: "success",
                where: "settings", autoremove: 3000});
            Session.set("settings-help-and-feedback", false);
        } else {
            check(options, {type: String, message: String});

            this.unblock();

            var user = this.userId && Meteor.users.findOne(this.userId);
            var name;
            var email;

            if (user) {
              name = user.profile && user.profile.name;
              email = user.emails && user.emails[0].address;

            } else {
              name = "Anonymous";
              email = "support@pushpickup.com";
            }

            sendEmail({
              from: name + " <" + email + ">",
              to: "support@pushpickup.com",
              subject: "Push Pickup feedback: " + options.type,
              text: options.message
            },
            {
              sendingToSystemUser: true
            });
        }
    }
});

recordsPerPage = 10;