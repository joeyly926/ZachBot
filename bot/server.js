const express = require('express');
const mongodb = require('mongodb').MongoClient;
const app = express();
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const _ = require('lodash');
const schedule = require('node-schedule');
const request = require('request');

const url = _.get(process, ['env', 'DATABASE_URL']);

const webexSecret =  _.get(process, ['env', 'WEBEX_SECRET']);

const webexMessageParams = {
   url: "https://api.ciscospark.com/v1/messages"
};

const replaceChars = {
   '’': '\'',
   '“': '\"',
}
var dbo;

const getWebexMessageParams = (token) => {
   const params = _.cloneDeep(webexMessageParams);
   return _.set(params, 'headers', { 'Authorization': `Bearer ${token}` });
}

const getBot = async (createdBy) => {
   const bot = await dbo.collection("bots").find({ createdBy }).toArray();
   
   return bot[0];
}

const getBots = async () => {
   const bots = await dbo.collection("bots").find({}).toArray();
   
   return bots;
}

const getWebexSecret = async (createdBy) => {
   const secret = await dbo.collection("bots").find({ createdBy }).toArray()[0].webexSecret;
   
   return secret;
}

const getWebexToken = async (createdBy) => {
   const token = await dbo.collection("bots").find({ createdBy }).toArray()[0].webexToken;
   
   return token;
}

/**
 * Validate a digital signature from Webex
 * @param {string} key secret
 * @param {string} sig dig sig from Webex
 * @param {string} raw JSON payload 
 */
const validateSignature = (key, sig, raw) => {
   return sig === crypto.createHmac('sha1', key) .update(raw).digest('hex');
}

/**
 * Converts the a quote to a SHA256 hash to prevent duplicate quotes
 * @param {string} quote 
 */
const getId = (quote) => {
   return crypto.createHash('sha256').update(quote, 'utf8').digest('hex');
}

/**
 * Gets a random quote from the database
 */
const getQuote = async (createdBy, search='') => {
   const result = await dbo.collection("quotes")
      .aggregate([{ $match: { bots: _.set({ }, createdBy, true), quote:{ $regex: search, $options: 'i' } } }, { $sample: { size: 1 } }]).toArray();

   if (result.length > 0) {
      return result[0].quote;
   }
   throw new Error("No quote");
}

/**
 * Ping all the rooms that a bot is in
 */
const pingRooms = async (bot, daily=false) => {
   let id;
   let token;
   if (typeof bot === 'string') {
      const foundBot = await dbo.collection("bots").find({ _id: bot }).toArray()[0];
      if (foundBot) {
         id = foundBot.createdBy;
         token = foundBot.token;
      }
   } else if (bot instanceof Object){
      id = bot.createdBy;
      token = bot.token;
   } 

   if (id && token) {
      getQuote(id).then(async quote => {
         if (quote) {
            const params = await getWebexMessageParams(token);
            _.each(bot.rooms, (room, roomId) => {
               if (!daily || daily && _.get(room, 'daily')) {
                  messageRoom(params, quote, roomId);
               }
            });
         } else {
            console.log("Unable to ping rooms");
         }
      });
   }
}

/**
 * Messages a room
 * @param {string} text 
 * @param {string} roomId 
 */
const messageRoom = async (params, text, roomId) => {
   _.set(params, 'form', { text, roomId })
   request.post(params, (err, res) => printResponseAndError(err, res));
}

/**
 * Ping a specific room
 * @param {string} roomId 
 */
const pingRoom = async (params, roomId, createdBy, search='') => {
   getQuote(createdBy, search).then(quote => {
      console.log("Quote found: " + quote);
      if (quote) {
         messageRoom(params, quote, roomId)
      } else {
         console.log("Unable to ping rooms");
      }
   });
}

/**
 * Add a quote to the database
 * @param {string} quote 
 */
const addQuote = async (quote, createdBy) => {
   const sanitizedQuote = _.replace(quote, new RegExp(_.join(_.keys(replaceChars), '|'), 'gi'), c => replaceChars[c]);
   const _id = getId(sanitizedQuote);
   const obj = { };
   obj['bots.' + createdBy] = true;
   dbo.collection("quotes").updateOne({ _id }, { $set: { _id, quote: sanitizedQuote, ...obj} }, { upsert: true }, (err, res) => printResponseAndError(err, res));
}

/**
 * Verify that the user's ID is in the database
 * @param {string} _id 
 */
const verifyUser = async (_id, createdBy) => {
   const obj = { };
   obj['bots.' + createdBy] = { $exists: true }
   const user = await dbo.collection("users").find({ _id, ...obj}).toArray();
   return !!_.head(user);
}

// TODO: be more specific with location of logs and formatting
/**
 * Print an response and error
 * @param {*} err 
 * @param {*} res 
 */
const printResponseAndError = (err, res) => {
   if (err) {
      console.log(err);
   } else if (res && res.body) {
      console.log(_.get(res, 'body'), _.get(res, 'statusCode'));
   }
}

/**
 * Check if a given roomId is in the database
 * @param {string} roomId
 */
const checkRoom = async (roomId, bot) => {
   console.log("Checking if room is in DB...");
   const room = _.get(bot, ['rooms', roomId]);
   if (!room || !room.daily) {
      console.log("Adding or updating room.");
      dbo.collection("bots").update({ createdBy: bot.createdBy }, { $set: { rooms:  _.set({ }, roomId, { daily: true }) } }, {upsert: true});
   } else {
      console.log("Found room.");
   }
}

/**
 * Toggles the daily quotes for a room
 * @param {string} roomId 
 */
const toggleDaily = async (roomId, bot, daily) => {
   console.log("Checking if room is in DB...");
   const foundRoom = _.get(bot, ['rooms', roomId]);
   const set = daily || ('daily' in foundRoom ? !foundRoom.daily : true);
   if (foundRoom) {
      console.log(`Setting daily to ${set}`);
      dbo.collection("bots").update({ createdBy: bot.createdBy }, { $set: { rooms:  _.set({ }, roomId, { daily: set }) } }, {upsert: true});
   } else {
      console.log("No room was found to toggle daily.");
   }

   return set;
}

const init = () => {
   schedule.scheduleJob('0 13 * * 1-5', async () => getBots().then(bots => _.each(bots, bot => pingRooms(bot, true))));
   app.use(express.json());
   app.use(bodyParser.json()); // support json encoded bodies
   app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

   // initialize DB with quotes from file
   var quotes = JSON.parse(fs.readFileSync('./messages.json'));
   _.each(quotes.quotes, quote => {
      _.set(quote, '_id', getId(_.get(quote, 'quote')));
   })
   mongodb.connect(url, { useNewUrlParser: true, useUnifiedTopology: true },
      (err, db) => {
         if (err) {
            console.error('Failed to connect to mongo on startup - retrying in 5 seconds', err);
            setTimeout(init, 5000);
         } else {
            dbo = db.db("zachbot");
            var bulkUpdate = _.map(quotes.quotes, quote => {
               return  {
                  updateOne: {
                     filter: { _id: quote._id },
                     update: { $set: { quote: quote.quote, bots: _.set({ }, _.get(quote, 'createdBy', undefined), true) } },
                     upsert: true
                  }
               };
            });
            dbo.collection("quotes").bulkWrite(bulkUpdate);
            var server = app.listen(8081, () => {
               var host = server.address().address;
               var port = server.address().port;
               console.log("Listening at http://%s:%s", host, port);
            })
         }
      }
   );

};

init();


/* APIs */

// app.post('/quote', async (req, res) => {
//    const quote = _.get(req, ['body', 'quote']);
//    if (!quote) {
// 	   res.status(400).end();
//    }

//    checkRoom(roomId);

//    addQuote(quote);
//    res.status(200).end();
// });

// app.get('/quote', async (_req, res) => {
//    getQuote().then(quote => {
//       if (!quote) {
//          res.status(500).send("Unable to get quote").end();
//       } else {
//          res.status(200).send(quote).end();
//       }
//    });
   
// })

// app.get('/ping', (req, res) => {
//    pingRooms();
//    res.status(200).end();
// });

// app.post('/ping', (req, res) => {
//    const { roomId } = _.get(req, ["body", "data"]);

//    if (!roomId) {
// 	   res.status(400).end();
//    }
   
//    checkRoom(roomId);

//    pingRoom(roomId);
//    res.status(200).end();
// });

app.post('/webex', async (req, res) => {
   console.log("Received POST request from Webex");
   const { createdBy, data } = _.get(req, 'body', { });
   const { roomId, personId } = data;
   const messageId = _.get(data, 'id');
   const signature = req.get('X-Spark-Signature');
   if (!validateSignature(webexSecret, signature, JSON.stringify(_.get(req, "body")))) {
      console.log("Sender is not authorized.");
      res.status(400).end();
   } else if (messageId && roomId) {
      // retrieve message from Webex
      const bot = await getBot(createdBy);
      const params = getWebexMessageParams(bot.token);
      const msgParams = _.cloneDeep(params);
      msgParams.url += `/${messageId}`;
      console.log("Sender is authorized.");
      request.get(msgParams, async (err, webexRes) => {
         printResponseAndError(err, webexRes);
         const message = _.get(JSON.parse(webexRes.body), 'text');
         if (message) {
            console.log("Received message: ", message);
            const splitMessage = message.split(" ");
            if (_.size(splitMessage) === 1 && roomId) {
               checkRoom(roomId, bot);
               console.log("Sending quote to room: ", roomId);
               pingRoom(params, roomId, createdBy);
            }
            else if (_.size(splitMessage) >= 2) {
               const command = splitMessage[1];
               const quote = _.join(_.slice(splitMessage, 2), ' ');
               switch (command) {
                  case ".add":
                     let authorized = true;
                     if (_.get(bot, 'auth', true)) {
                        authorized = await verifyUser(personId, createdBy);
                     }
                     if (authorized) {
                        console.log("Adding quote");
                        // TODO: add messages for different bots instead of just ZachBot
                        messageRoom(params, "I allow it.", roomId);
                        addQuote(quote, createdBy);
                     } else {
                        console.log("Invalid user");
                        messageRoom(params, "You are NOT allowed to tell me what to say OwO.", roomId);
                     }
                     break;
                  case ".get":
                     pingRoom(params, roomId, createdBy, quote);
                     break;
                  case ".daily":
                     toggleDaily(roomId, bot).then((set) => {
                        const response = set ? 'Yessssss' : 'Wow, you gonna do me like that?';
                        messageRoom(params, response, roomId);
                     });
                     break;
                  case ".help":
                     const commands  = {
                        '.add': 'As an authorized user, add a quote.',
                        '.get': 'Search for a quote!',
                        '.daily': 'Turn my daily quotes on or off!',
                        '.help': 'Get some help!'
                     }
                     messageRoom(
                        params,
                        _.join(
                           _.map(
                              commands, (description, command) => `\`${command}\`: ${description}`
                           ),
                           '\n')
                        , roomId);
                     break;
                  default:
                     break;
               }
            }
         }
         res.status(200).end();
      });

   } else {
      console.log("SoMethiNg BrOkE");
      res.status(400).end();
   }
});