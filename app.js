'use strict';

const env = require('dotenv').config().parsed;
const express = require('express');
const app = express();
const http = require('http');
const httpServer = http.createServer(app);
const Monetrum = require('monetrum-node-client');
const fs = require('fs').promises;
const bodyParser = require('body-parser');
const { MongoClient, ObjectID } = require('mongodb');
const moment = require('moment');
const nodeMailer = require('nodemailer');
const cors = require('cors');
const smtpPassword = require('aws-smtp-credentials');
const stc = async (callback) => { try { return await callback() } catch (e){ return e } };
var transporter = nodeMailer.createTransport({
    port: 465,
    host: env.MAIL_HOST,
    secure: true,
    auth: {
      user: env.MAIL_USER,
      pass: smtpPassword(env.MAIL_PASS),
    },
    debug: true
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// app.use(cors());

async function readLastSeq(){
    let lastSeq = stc(async () => parseInt(await fs.readFile(__dirname + '/lastseq.txt') || 0) || 0 );
    if(lastSeq instanceof Error){
        throw new Error('lastSeq Okunamadı');
    }

    return lastSeq;
}

async function writeLastSeq(seq) {
    let result = stc(async () => await fs.writeFile(__dirname + '/lastseq.txt', String(seq)));
    if(result instanceof Error){
        throw new Error('lastSeq yazılamadı');
    }

    return true;
}

function replaceAll(str, search, replace){
    while(true){
        if(str.indexOf(search) === -1) break;
        str = str.replace(search, replace);
    }

    return str;
}

async function parifixCallback(db, txes){
    for(let tx of txes){
        console.log('Para girdi işlemi', tx.hash, tx.seq);
        let wallet = await db.collection('wallets').findOne({ WalletNumber: tx.from });
        let insert = { UserID: wallet.UserID, Type: 3, Amount: tx.amount, Desc: 'tx:' + tx.hash, Date: moment().utc().toDate(), Symbol: tx.asset,  tx: tx.hash, Wallet: tx.from, Status: 1 };
        await db.collection('balances').insertOne(insert);
        //---------------------------------------------------------------------------------------------------------------------------------------------//
        let user = await db.collection('users').findOne({ _id: wallet.UserID });
        let { Title: title, Content: content } = await db.collection('contents').findOne({ MenuTitle: 'ParaEklendi' });

        title = replaceAll(title, '{Amount}', tx.amount);
        title = replaceAll(title, '{Symbol}', tx.asset);
        content = replaceAll(content, '{Amount}', tx.amount);
        content = replaceAll(content, '{Symbol}', tx.asset);
        content = replaceAll(content, '{Ad}', user.Name)
        content = replaceAll(content, '{Soyad}', user.Surname);
        content = replaceAll(content, '{txid}', tx.hash);
        content = replaceAll(content, '{Wallet}', tx.from);

        let mailOptions = { from: env.MAIL_FROM, to: user.Email, subject: title, html: content };
        let maillist = env.NOTIFY_ADMIN.split(',').map(x => x.trim());
        var mailOptionsAdmins = { from: env.MAIL_FROM, to: maillist, subject: 'Yeni Koin Yatırma - ' + title, html: content };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                return console.log(error);
            }
            
            console.log('Message %s sent: %s', info.messageId, info.response);
        });

        transporter.sendMail(mailOptionsAdmins, (error, info) => {
            if (error) {
                return console.log(error);
            }
            
            console.log('Message %s sent: %s', info.messageId, info.response);
        });
    }
}

async function init(){
    
    let monetrum = await new Monetrum(env.NODE_URI);
    let client = await MongoClient.connect(env.DATABASE_CS, { useNewUrlParser: true });
    let db = client.db(env.DATABASE);

    app.get('/get-wallet', async (req, res) => {
        // console.log('istek geldi')
        let resp = await stc(() => monetrum.generate({ account_id: req.query.account_id })); 
        if(resp instanceof Error){
            console.log(resp);
            res.status(500);
            res.json({ status: 'error', message: resp.message });
            return;
        }
        
        console.log('cüzdan oluşturuldu');
        res.json({ status: 'ok', WalletNumber: resp.wallet.address, WalletData: resp.wallet.private_key });
    });
    
    app.get('/get-balance', async (req, res) => {
        let address = req.query.wallet || null;
        let asset = req.query.asset || null;
        let resp = await stc(() => monetrum.getBalance({ address, asset })); 
        if(resp instanceof Error){
            console.log(resp);
            res.status(500);
            res.json({ status: 'error', message: resp.message });
            return;
        }

        res.json({ status: 'ok', balance: resp.balance || 0 });
    });

    app.post('/send', async (req, res) => { 
        if(!req.body.pwd && req.body.pwd !== env.PWD){
            res.status(500);
            console.log('password geçersiz');
            res.json({ status: 'error', message: 'password geçersiz' });
            return;
        }
        
        let data = {};
        let infrom = 'from' in req.body;
        if(infrom)  data = req.body;
        if(!infrom) data = { ...req.body, from: env.FROM };
        let resp = await stc(() => monetrum.send(data)); 
        if(resp instanceof Error){
            console.log(resp);
            res.status(500);
            res.json({ status: 'error', message: resp.message });
            return;
        }

        console.log('send işlemi gerçekleşti', resp.tx);
        res.json({ status: 'ok', tx: resp.tx });
    });

    app.get('/export', async (req, res) => { 
        if(!req.body.pwd && req.body.pwd !== env.PWD){
            res.status(500);
            res.json({ status: 'error', message: 'password geçersiz' });
            return;
        }
        
        let resp = await stc(() => monetrum.export({ address: req.query.address })); 
        if(res instanceof Error){
            res.status(500);
            res.json({ status: 'error', message: resp.message });
            return;
        }

        res.json({ status: 'ok', wallet: resp.wallet });
    });
    
    let running = false;
    let transactionScanner = async () => {
        if(running === true){
            return;
        }

        running = true;
        console.log('tx taranıyor');

        let lastSeq = await readLastSeq();
        console.log('son taranan tx seq numarası', lastSeq);
        while(true){
            let response = await monetrum.getTxList({ filters: [ { field: 'seq', operator: '>', value: lastSeq }, { field: 'type', operator: '=', value: 2 } ] });
            if(response.txes.length === 0){
                break;
            }

            lastSeq = response.txes[ response.txes.length - 1 ].seq;
            let froms = response.txes.map(tx => tx.from).filter((value, index, self) => self.indexOf(value) === index);
            let validAddresses = (await db.collection('wallets').find({ WalletNumber: { $in: froms } }).toArray()).map(({ WalletNumber }) => WalletNumber);
            let ftxes = response.txes.filter(tx => !!validAddresses.find(address => tx.from === address));
            if(ftxes.length > 0){
                parifixCallback(db, ftxes);
            }
        }

        await writeLastSeq(lastSeq);
        running = false;
    }

    setInterval(transactionScanner, 5000);
    httpServer.listen(parseInt(env.LISTEN_PORT), env.LISTEN_HOST);
}

init().then(() => console.log('ok'));