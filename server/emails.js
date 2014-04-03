// Extend the functionality of `accounts-password` package
// to send custom emails


// After `accounts-base` package has loaded, modify Accounts.urls
Meteor.startup(function () {
  // Overwrite meteor/packages/accounts-base/url_server.js
  // so that accounts routes work with iron-router.
  // Idea from samhatoum (4th comment on
  // https://github.com/EventedMind/iron-router/issues/3).
  (function () {
    "use strict";

    Accounts.urls.resetPassword = function (token) {
      return Meteor.absoluteUrl('reset-password#' + token);
    };

    Accounts.urls.verifyEmail = function (token) {
      return Meteor.absoluteUrl('verify-email#' + token);
    };

    Accounts.urls.enrollAccount = function (token) {
      return Meteor.absoluteUrl('enroll-account#' + token);
    };

  })();
});

// Return a new email with an `html` body that is a
// Markdown conversion of the input email's `text` body.
withHTMLbody = function (email) {
  var html = utils.converter.makeHtml(email.text);
  return _.extend({html: html}, _.omit(email, 'html'));
};

// Return a new email with an appended link to no longer receive any emails
// from Push Pickup. This function is meant to be composed with `withHTMLbody`
// as in the expression `withHTMLbody(withTotalUnsubscribe(email))`.
withTotalUnsubscribe = function (email) {
  var link = Meteor.absoluteUrl('totally-unsubscribe');
  var text = email.text +
        "\n\n===\n[Unsubscribe]("+link+") from all emails from Push Pickup.";
  return _.extend({text: text}, _.omit(email, 'text'));
};


// Use instead of `Email.send` to ensure defaults such as a link at bottom
// to unsubscribe from all emails, and an html body derived from the text body.
sendEmail = function (email, options) {
  options = _.extend({
    withHTMLbody: ! Meteor.settings.DEVELOPMENT,
    withTotalUnsubscribe: true
  }, options);
  if (options.withTotalUnsubscribe) {
    email = withTotalUnsubscribe(email);
  }
  if (options.withHTMLbody) {
    email = withHTMLbody(email);
  }
  Email.send(email);
};

// An abstraction of Accounts.sendEnrollmentEmail to include a
// custom template name as a parameter.
//
// send the user an email informing them that their account was created, with
// a link that when opened both marks their email as verified and forces them
// to choose their password. The email must be one of the addresses in the
// user's emails field, or undefined to pick the first email automatically.
//
// This is not called automatically. It must be called manually if you
// want to use enrollment emails.
//
sendEnrollmentEmail = function (userId, email, template, options) {

  // Make sure the user exists, and email is in their addresses.
  var user = Meteor.users.findOne(userId);
  if (!user)
    throw new Error("Can't find user");
  // pick the first email if we weren't passed an email.
  if (!email && user.emails && user.emails[0])
    email = user.emails[0].address;
  // make sure we have a valid email
  if (!email || !_.contains(_.pluck(user.emails || [], 'address'), email))
    throw new Error("No such email for user.");
  // Make sure we have a valid template
  if (!template || !emailTemplates[template])
    throw new Error("No such email template.");
  // Templates are responsible for checking that the `options`
  // passed to them is what they need


  var token = Random.id();
  var when = new Date();
  Meteor.users.update(userId, {$set: {
    "services.password.reset": {
      token: token,
      email: email,
      when: when
    }
  }});

  var enrollAccountUrl = Accounts.urls.enrollAccount(token);
  sendEmail({
    to: email,
    from: emailTemplates.from,
    subject: emailTemplates[template].subject(user, options),
    text: emailTemplates[template].text(user, enrollAccountUrl, options)
  });
};

// Notify organizer about players joining/leaving game.
notifyOrganizer = function (gameId, options) {
  check(gameId, String);
  check(options, Match.Where(function (options) {
    check(options, {
      joined: Match.Optional({
        userId: String,
        name: String,
        numFriends: Match.Optional(Number)
      }),
      left: Match.Optional({
        userId: String,
        name: String,
        numFriends: Match.Optional(Number)
      })
    });
    return options.joined || options.left;
  }));
  var game = Games.findOne(gameId);
  if (! game)
    throw new Error("Game not found");

  // Don't notify organizer about his own joining/leaving or friend-adding.
  if (options.joined && options.joined.userId === game.creator.userId ||
      options.left && options.left.userId === game.creator.userId) {
    return false;
  }

  var creator = Meteor.users.findOne(game.creator.userId);

  var email = {
    from: emailTemplates.from,
    to: creator.emails[0].address
  };
  var gameInfo = utils.displayTime(game) + " " + game.type;
  var text = "For your reference, [here]("
        + Meteor.absoluteUrl('g/'+gameId) + ")"
        + " is a link to your game.\n\n"
        + "Thanks for organizing.";
  var who;
  if (options.left) { // people left
    who = options.left.name;
    if (options.left.numFriends && options.left.numFriends > 0) {
      who += " and "+options.left.numFriends+" friend";
      if (options.left.numFriends > 1) {
        who+="s";
      }
    }
    sendEmail(_.extend({
      subject: who+" left your "+gameInfo+" game",
      text: text
    }, email));
  } else {
    // Player added self or added friends
    // If player did both at once, two emails will be sent
    who = options.joined.name;
    if (options.joined.numFriends && options.joined.numFriends > 0) {
      who += " added "+options.joined.numFriends+" friend";
      if (options.joined.numFriends > 1) {
        who += "s";
      }
      who += " to";
    } else {
      who += " joined";
    }
    sendEmail(_.extend({
      subject: who+" your "+gameInfo+" game",
      text: text
    }, email));
  }
};
