var express = require('express');
var mongodb = require('mongodb').MongoClient;
var app = express();
var bodyParser = require('body-parser');
const crypto = require('crypto');
var fs = require('fs');
var _ = require('lodash');
var schedule = require('node-schedule');
var request = require('request');


var url = _.get(process, ['env', 'DATABASE_URL']);

var webexMessageParams = {
   headers: {
      'Authorization': 'Bearer ZTYzYTc4MDctZjY5ZC00YzRhLWI5ZTItMjY3ZGE5YWU3MzgwNDU0NmI2YTYtNWZk_PF84_1eb65fdf-9643-417f-9974-ad72cae0e10f'

   },
   url: "https://api.ciscospark.com/v1/messages"
};

const getId = (quote) => {
   return crypto.createHash('sha256').update(quote, 'utf8').digest('hex');
}

const getQuote = async () => {
   const result = await dbo.collection("quotes").aggregate([{'$sample': {'size': 1 }}]).toArray();
   return result[0].quote;
}

const pingRooms = async () => {
   const rooms = await dbo.collection("rooms").find().toArray();
   getQuote().then(quote => {
      if (quote) {
         _.each(rooms, room => {
            const params = _.cloneDeep(webexMessageParams);
            _.set(params, 'form', {"text": quote , "roomId": room._id})
            request.post(params, (err, res) => printError(err, res));
         });
      } else {
         console.log("Unable to ping rooms");
      }
   });
}

const pingRoom = async (roomId) => {
   getQuote().then(quote => {
      if (quote) {
         const params = _.cloneDeep(webexMessageParams);
         _.set(params, 'form', {"text": quote , "roomId": roomId})
         request.post(params, (err, res) => printError(err, res));
      } else {
         console.log("Unable to ping rooms");
      }
   });
}

const pingWeatherBot = async (roomId) => {
   _.set(params, 'form', {"markdown": "" , "roomId": room._id})
   request.post(params, (err, res) => printError(err, res));
}

const printError = (err, res) => {
   if (err) {
      console.log(err);
   } else {
      console.log(res.body, res.statusCode)
   }
}

var dbo;
const init = () => {
   schedule.scheduleJob('0 13 * * 1-5', pingRooms);
   app.use(express.json());
   app.use(bodyParser.json()); // support json encoded bodies
   app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

   // initialize DB with quotes from file
   var quotes = JSON.parse(fs.readFileSync('./messages.json'));
   var rooms = JSON.parse(fs.readFileSync('./rooms.json'));
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
            
            dbo.collection("quotes").insertMany(quotes.quotes, (err, res) => {
               if (err) {
                  console.log(err);
               } else {
                  console.log("Quotes populated");
               }
            });
            dbo.collection("rooms").insertMany(rooms.rooms, (err, res) => {
               if (err) {
                  console.log(err);
               } else {
                  console.log("Rooms populated");
               }
            });
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

   const _id = getId(quote);
   dbo.collection("quotes").insertOne({_id, quote}, (err, res) => {
      if (err) {
         console.log(error);
      } else {
         console.log("1 quote inserted");
      }
   });
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
   const { roomId } = req.body.data;
   pingRoom(roomId);
   res.status(200).end();
});