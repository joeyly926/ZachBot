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
   headers: {
      'Authorization': `Bearer ${_.get(process, ['env', 'WEBEX_TOKEN'])}`

   },
   url: "https://api.ciscospark.com/v1/messages"
};
var dbo;

// TODO: modularize for other *Bots.

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
const getQuote = async (search=null) => {

   const result = search ? 
      await dbo.collection("quotes").aggregate([{ $match: { quote: { $regex: search, $options: 'i' } } }, { $sample: { size: 1 } }]).toArray()
      : await dbo.collection("quotes").aggregate([{ $sample: { size: 1 } }]).toArray();
   
   if (result.length > 0) {
      return result[0].quote;
   }
   throw new Error("No quote");
}

/**
 * Ping all the rooms that ZachBot is in
 */
const pingRooms = async () => {
   const rooms = await dbo.collection("rooms").find().toArray();
   getQuote().then(quote => {
      if (quote) {
         _.each(rooms, room => {
            messageRoom(quote, room._id);
         });
      } else {
         console.log("Unable to ping rooms");
      }
   });
}

/**
 * Messages a room
 * @param {string} text 
 * @param {string} roomId 
 */
const messageRoom = async (text, roomId) => {
   const params = _.cloneDeep(webexMessageParams);
   _.set(params, 'form', {text, roomId})
   request.post(params, (err, res) => printResponseAndError(err, res));
}

/**
 * Ping a specific room
 * @param {string} roomId 
 */
const pingRoom = async (roomId, search=null) => {
   getQuote(search).then(quote => {
      if (quote) {
         const params = _.cloneDeep(webexMessageParams);
         _.set(params, 'form', {"text": quote , "roomId": roomId})
         request.post(params, (err, res) => printResponseAndError(err, res));
      } else {
         console.log("Unable to ping rooms");
      }
   });
}

/**
 * Add a quote to the database
 * @param {string} quote 
 */
const addQuote = async (quote) => {
   const _id = getId(quote);
   dbo.collection("quotes").insertOne({_id, quote}, (err, res) => printResponseAndError(err, res));
}

/**
 * Verify that the user's ID is in the database
 * @param {string} _id 
 */
const verifyUser = async (_id) => {
   const user = await dbo.collection("users").find({ _id }).toArray();
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
const checkRoom = async (roomId) => {
   console.log("Checking if room is in DB...");
   const foundRoom = await findRoom(roomId);
   if (!foundRoom || foundRoom.daily === null) {
      console.log("Adding or updating room.");
      dbo.collection("rooms").insertOne({ _id: roomId, daily: true }, (err, res) => printResponseAndError(err, res));
   } else {
      console.log("Found room.");
   }
}

/**
 * Toggles the daily quotes for a room
 * @param {string} roomId 
 */
const toggleDaily = async (roomId, daily) => {
   console.log("Checking if room is in DB...");
   const foundRoom = await findRoom(roomId);
   const set = daily || !_.get(foundRoom, 'daily') || false;
   if (foundRoom) {
      console.log(`Setting daily to ${set}`);
      dbo.collection("rooms").update({ _id: roomId }, { _id: roomId, daily: set}, {upsert: true});
   } else {
      console.log("No room was found to toggle daily.");
   }

   return set;
}

/**
 * Finds a room given an ID
 * @param {string} _id id of room
 */
const findRoom = async (_id) => {
   try {
      // db query should only find 1 room. If there's more than 1 room, good luck ;)
      const room = await dbo.collection("rooms").find({ _id }).toArray();
      return _.head(room);
   } catch {
      return null;
   }
}

const init = () => {
   schedule.scheduleJob('0 13 * * 1-5', pingRooms);
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
                     update: { $set: { quote: quote.quote } },
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

app.post('/quote', async (req, res) => {
   const quote = _.get(req, ['body', 'quote']);
   if (!quote) {
	   res.status(400).end();
   }

   checkRoom(roomId);

   addQuote(quote);
   res.status(200).end();
});

app.get('/quote', async (_req, res) => {
   getQuote().then(quote => {
      if (!quote) {
         res.status(500).send("Unable to get quote").end();
      } else {
         res.status(200).send(quote).end();
      }
   });
   
})

app.get('/ping', (req, res) => {
   pingRooms();
   res.status(200).end();
});

app.post('/ping', (req, res) => {
   const { roomId } = _.get(req, ["body", "data"]);

   if (!roomId) {
	   res.status(400).end();
   }
   
   checkRoom(roomId);

   pingRoom(roomId);
   res.status(200).end();
});

app.post('/webex', (req, res) => {
   console.log("Received POST request from Webex");
   const messageId = _.get(req, ["body", "data", "id"]);
   const roomId = _.get(req, ["body", "data", "roomId"]);
   const personId = _.get(req, ["body", "data", "personId"]);
   const signature = req.get('X-Spark-Signature');
   if (!validateSignature(webexSecret, signature, JSON.stringify(_.get(req, "body")))) {
      console.log("Sender is not authorized.");
      res.status(400).end();
   } else if (messageId && roomId) {
      // retrieve message from Webex 
      const params = _.cloneDeep(webexMessageParams);
      params.url += `/${messageId}`;
      console.log("Sender is authorized.");
      request.get(params, (err, webexRes) => {
         printResponseAndError(err);
         const message = _.get(JSON.parse(webexRes.body), 'text');
         if (message) {
            const splitMessage = message.split(" ");
            if (_.size(splitMessage) === 1 && roomId) {
               checkRoom(roomId);
               console.log("Sending quote to room: ", roomId);
               pingRoom(roomId);
            }
            else if (_.size(splitMessage) >= 2) {
               const command = splitMessage[1];
               const quote = _.join(_.slice(splitMessage, 2), ' ');
               switch (command) {
                  case ".add":
                     verifyUser(personId).then((valid) => {
                        if (valid) {
                           console.log("Adding quote");
                           messageRoom("I allow it.", roomId);
                           addQuote(quote);
                        } else {
                           console.log("Invalid user");
                           messageRoom("You are NOT allowed to tell me what to say OwO.", roomId);
                        }
                     })
                     break;
                  case ".get":
                     pingRoom(roomId, quote);
                     break;
                  case ".daily":
                     toggleDaily(roomId).then((set) => {
                        const response = set ? 'Yessssss' : 'Wow, you gonna do me like that?';
                        messageRoom(response, roomId);
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
      res.status(400).end();
   }
});