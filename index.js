const express = require('express');
const app = express();
const path = require('path');
const http = require('http').createServer(app)
const geoip = require('geoip-lite');
const mongoose = require('mongoose')
require('mongoose-long')(mongoose);
const Long = mongoose.Schema.Types.Long
const io = require('socket.io')(http, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
        transports: ['websocket', 'polling'],
    },
    allowEIO3: true
})
const port = process.env.PORT || 3000

let clients = []
let banList = {}
let scores = null

const MAX_ALLOWED_SCORE_PER_TICK = 30
const BAN_TIME_LIMIT = 60 // seconds

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/popclick'
mongoose.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true })

const Country = mongoose.model('Country', mongoose.Schema({
    name: String,
    score: Long
}));

io.on('connection', async (socket) => {
    console.log(`Received from ${socket.handshake.address}`)
    // cek geolocation
    let geoinfo = geoip.lookup(socket.handshake.address)
    let country = (geoinfo == null) ? "NO_GEOLOCATION" : geoinfo.country
    socket.country = country

    // simpan semua user yang terkoneksi
    let clientIndex = clients.indexOf(socket)
    if (clientIndex != -1) {
        clients[clientIndex] = socket
    } else {
        clients.push(socket)
    }

    if (checkBan(socket)) {
        notifyBan(socket)
    }

    // emit country information
    socket.emit('country', socket.country)

    // emit scoreboard ke user yg baru join
    if (scores != null)
        socket.emit('scoreboard', scores)

    // tambah score tiap ada update dari user
    socket.on('update', async (data) => {
        if (scores != null && data.score > 0) {
            // anti curang langsung banned IP selama X detik
            if (checkBan(socket)) {
                notifyBan(socket)
            } else if (data.score > MAX_ALLOWED_SCORE_PER_TICK) {
                banUser(socket)
            } else {
                if (socket.country != "NO_GEOLOCATION") {
                    let score = parseInt(data.score)
                    if (scores[socket.country] == null) scores[socket.country] = score
                    scores[socket.country] += score
                }
            }
        }
    })

    // hapus user dari clients saat disconnect
    socket.on('disconnect', () => {
        let clientIndex = clients.indexOf(socket)
        if (clientIndex == -1) {
            return
        }
        clients.splice(clientIndex, 1)
    })
})

function checkBan(socket) {
    if (banList[socket.handshake.address] == null) {
        banList[socket.handshake.address] = {
            ban: false,
            lastBan: null
        }
    }

    banInfo = banList[socket.handshake.address]
    if (banInfo.ban) {
        let now = Date.now()
        let timeDif = now - banInfo.lastBan
        if (timeDif/1000 > BAN_TIME_LIMIT) {
            banList[socket.handshake.address] = {
                ban: false,
                lastBan: null
            }
            return false
        } else {
            return true
        }
    }
    return false
}

function notifyBan(socket) {
    socket.emit('banned', BAN_TIME_LIMIT)
}

function banUser(socket) {
    banList[socket.handshake.address] = {
        ban: true,
        lastBan: Date.now()
    }
    notifyBan(socket)
}

function broadcastScores() {
    if (scores != null)
        io.emit('scoreboard', scores)
}

function loadScores() {
    updateScores()
    setInterval(saveScores, 5000) // simpan secara periodik agar loadnya tidak berat
}

function updateScores() {
    // update scrore dari database
    let results = {}
    let cursor = Country.find({}, function(err, data) {
        data.forEach(doc => {
            results[doc.name] = parseInt(doc.score)
        })
        scores = results
    })
}

function saveScores() {
    // save score ke database
    for (const country in scores) {
        Country.findOneAndUpdate({name: country}, {score: scores[country]}, {
            returnNewDocument: true, useFindAndModify: false
        }).then(data => {
            if (data == null) {
                Country.create({name: country, score: scores[country]})
            }
        }, err => {
            console.log("Error Update in Index1", err);
        });

    }
}

if (scores == null) loadScores()
setInterval(broadcastScores, 5000) // setiap x detik, broadcast scoreboard ke semua peserta

http.listen(port, () => console.log(`App listening at port ${port}`))