var WebSocketServer = require('ws').Server;
var http = require('http');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var _ = require('underscore');

var cert = fs.readFileSync(__dirname + '/../var/jwt/public.pem');

var server = http.createServer(function(request, response) {
    // process HTTP request. Since we're writing just WebSockets server
    // we don't have to implement anything.
});
server.listen(8000, function() {});

// create the server
wsServer = new WebSocketServer({
    server: server,
    verifyClient: function (info, cb) {

      var token = info.req.headers.authorization;
      if (!token) {
        console.log('No JWT found in request');
        return cb(false, 401, 'Unauthorized');
      }

      token = token.substring('Bearer '.length);

      jwt.verify(token, cert, function (err, decoded) {
        if (err) {
          console.log('Invalid JWT', err);
          cb(false, 401, 'Unauthorized');
        } else {
          // info.req.user = decoded //[1]
          console.log('JWT verified successfully', decoded);
          cb(true);
        }
      });

    }
});

var redis = require('redis').createClient();

var connectionIDCounter = 0;
var connections = [];

// WebSocket server
wsServer.on('connection', function(ws) {

    // var connection = request.accept(null, request.origin);
    var username;
    var courierID;
    var timeoutID;

    // Store a reference to the connection using an incrementing ID
    ws.id = connectionIDCounter++;

    connections.push(ws);

    console.log('New connection with id = ' + ws.id);

    // TODO Use setTimeout
    // var timeoutID = setTimeout(pollRedis, 500);
    // var intervalID = setInterval(function() {
    //   redis.rpoplpush('Orders', 'Orders', function(err, orderID) {
    //     redis.hgetall('Orders:' + orderID, function(err, order) {
    //       // GEORADIUS locations -0.11759 51.50574 1 km WITHDIST ASC
    //       redis.georadius('GeoSet', order.longitude, order.latitude, 5, "km", function(err, couriers) {
    //         _.each(couriers, function(courier) {
    //           if (courier === username) {
    //             console.log('Found a matching order');
    //           }
    //         });
    //       });
    //     })
    //   })
    // }, 2500);

    // connection.intervalID = intervalID;

    // pubSubClient.subscribe("orders");

    // pubSubClient.on("message", function(channel, message) {
    //   console.log("Message '" + message + "' on channel '" + channel + "' arrived!")
    //   connection.sendUTF(JSON.stringify({
    //     channel: channel,
    //     message: JSON.parse(message)
    //   }));
    // });

    // Polls Redis to look for orders nearby the courier
    var pollRedis = function(courierID, callback) {
      redis.georadiusbymember('GeoSet', 'courier:' + courierID, 5, "km", 'WITHDIST', function(err, matches) {
        var orders = _.reject(matches, function(match) {
          return match[0] === 'courier:' + courierID;
        });
        // An order has been found : notify courier, stop polling
        if (orders.length > 0) {
          var order = _.first(orders);
          var orderKey = order[0];
          var orderID = parseInt(orderKey.substring('order:'.length), 10);
          redis.geopos('GeoSet', orderKey, function(err, results) {
            var latitude = results[0][0];
            var longitude = results[0][1];
            callback({
              id: orderID,
              longitude: parseFloat(longitude),
              latitude: parseFloat(latitude),
            });
            clearTimeout(timeoutID);
          })
        }
      });
      timeoutID = setTimeout(pollRedis.bind(null, courierID, callback), 1000);
    }

    var onOrderFound = function(order) {
      console.log(order);
      ws.send(JSON.stringify({
        type: 'order',
        order: order
      }));
    }

    var onError = function(name, message) {
      ws.send(JSON.stringify({
        type: 'error',
        error: {
          name: name,
          message: message
        }
      }));
    }

    ws.on('message', function(messageText) {

      var message = JSON.parse(messageText);

      if (message.type === 'updateCoordinates') {

        courierID = message.user.id;
        ws.courierID = courierID;

        var statusKey = 'Courier:'+courierID+':status';

        redis.get(statusKey, function(err, status) {

          console.log('Courier ' + courierID + ', updating position for courier "' + courierID + '" in Redis...');
          console.log('Courier ' + courierID + ', status = ' + status);

          ws.send(JSON.stringify({
            type: 'status',
            status: status
          }));

          if (!status) {
            status = 'AVAILABLE';
            redis.set(statusKey, status);
          }

          if (status === 'AVAILABLE') {
            redis.geoadd('GeoSet',
              message.coordinates.latitude,
              message.coordinates.longitude,
              'courier:' + courierID
            );
            if (!timeoutID) {
              console.log('Start polling Redis for courier ' + courierID);
              timeoutID = setTimeout(pollRedis.bind(null, courierID, onOrderFound), 500);
            }
          }

          if (status === 'BUSY') {
            redis.geoadd('OrdersPicked',
              message.coordinates.latitude,
              message.coordinates.longitude,
              'courier:' + courierID
            );
          }
        });
      }

    });

    ws.on('close', function() {

      console.log('Connection ' + ws.id + ' closed !');
      clearTimeout(timeoutID);

      console.log('Removing courier "' + courierID + '" from Redis...');
      redis.zrem('GeoSet', 'courier:' + courierID);

      var connectionsIndex = connections.indexOf(ws);
      if (-1 !== connectionsIndex) {
        connections.splice(connectionsIndex, 1);
      }

      // clearInterval(connection.intervalID);

      console.log('Number of connections : ' + _.size(connections));
    });
});

process.on('SIGINT', function () {
  _.each(connections, function(connection) {
    if (connection) {
      console.log('Removing courier "' + connection.courierID + '" from Redis...');
      redis.zrem('GeoSet', 'courier:' + connection.courierID);
    }
  });
});