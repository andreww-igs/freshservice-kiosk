require('dotenv').config()

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const sql = require('mssql');
const ldap = require('ldapjs');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// FreshService API configuration
const freshserviceDomain = process.env.FRESHSERVICE_URL;
const apiKey = process.env.FRESHSERVICE_API_KEY;

const authHeader = {
    headers: {
        'Authorization': 'Basic ' + Buffer.from(apiKey + ':X').toString('base64'),
        'Content-Type': 'application/json'
    }
};

// Identity1 SQL Server configuration
const sqlConfig = {
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    options: {
        encrypt: false,
        trustServerCertificate: true // Change to true for local dev / self-signed certs
    }
};

// Active Directory configuration
const adConfig = {
    url: process.env.ACTIVE_DIRECTORY_URL,
    baseDN: process.env.ACTIVE_DIRECTORY_BASE_DN,
    username: process.env.ACTIVE_DIRECTORY_USER,
    password: process.env.ACTIVE_DIRECTORY_PASSWORD
};

// Initialize SQLite database in memory
const db = new sqlite3.Database(':memory:');
let dbReady = false;

db.serialize(() => {
    db.run("CREATE TABLE requesters (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, display_name TEXT, primary_email TEXT, mobile_phone_number TEXT, work_phone_number TEXT, barcode TEXT, pager TEXT, department_name TEXT)");
    db.run("CREATE TABLE agents (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, display_name TEXT, email TEXT, department_id TEXT, department_name TEXT)");

    const refreshRequesters = async () => {
        let url = `https://${freshserviceDomain}/api/v2/requesters?include_agents=true`;
        let requesters = [];
        try {
            db.run("DELETE FROM requesters");
            const stmt = db.prepare("INSERT INTO requesters (id, first_name, last_name, display_name, primary_email, mobile_phone_number, work_phone_number, barcode, pager, department_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

            let total = 0;
            while (url) {
                const response = await axios.get(url, authHeader);
                requesters = requesters.concat(response.data.requesters);
                // total += response.data.requesters.length;
                // console.log('Requesters fetched from FreshService:', total);

                // Check for next page
                if (response.headers['x-ratelimit-remaining'] <= 10)
                {
                    console.warn(`API rate limit nearly depleted; rate limit remaining: ${response.headers['x-ratelimit-remaining']}`);
                    await new Promise(r => setTimeout(r, 15000));
                }
                const linkHeader = response.headers.link;
                const nextLink = linkHeader && linkHeader.split(',').find(link => link.includes('rel="next"'));
                url = nextLink ? nextLink.split(';')[0].slice(1, -1) : null;
            }

            // Fetch barcodes in a batch from Identity1
            const emails = requesters.map(r => r.primary_email);
            const barcodes = await getBarcodesForRequesters(emails);
            const pagers = await getPagersForRequesters();

            requesters.forEach(requester => {
                const barcode = barcodes[requester.primary_email] || null;
                const pager = pagers[requester.primary_email] || null;

                if (requester.active == true)
                {
                    total++;
                    if (requester.department_names != null) {
                        const department_name = requester.department_names[0];
                        stmt.run(requester.id, requester.first_name, requester.last_name, requester.first_name + ' ' + requester.last_name, requester.primary_email, requester.mobile_phone_number, requester.work_phone_number, barcode, pager, department_name);
                    } else {
                        stmt.run(requester.id, requester.first_name, requester.last_name, requester.first_name + ' ' + requester.last_name, requester.primary_email, requester.mobile_phone_number, requester.work_phone_number, barcode, pager, null);
                    }
                }
            });
            
            stmt.finalize();
            let date = new Date();
            console.log(`Requesters data refreshed: ${total} @ ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} ${date.getDate()}/${date.getMonth()}/${date.getFullYear()}`);
        } catch (err) {
            console.error('Error fetching requesters:', err);
        }
    };

    const refreshAgents = async () => {
        let url = `https://${freshserviceDomain}/api/v2/agents`;
        try {
            db.run("DELETE FROM agents");
            const stmt = db.prepare("INSERT INTO agents (id, first_name, last_name, display_name, email, department_id, department_name) VALUES (?, ?, ?, ?, ?, ?, ?)");
            
            let total = 0;
            while (url) {
                const response = await axios.get(url, authHeader);
                const agents = response.data.agents;
                total += response.data.agents.length;
                
                agents.forEach(agent => {
                    if (agent.department_ids != null && agent.department_names != null) {
                        const department_id = agent.department_ids[0];
                        const department_name = agent.department_names[0];
                        stmt.run(agent.id, agent.first_name, agent.last_name, agent.first_name + ' ' + agent.last_name, agent.email, department_id, department_name);
                    } else {
                        stmt.run(agent.id, agent.first_name, agent.last_name, agent.first_name + ' ' + agent.last_name, agent.email, null, null);
                    }
                });

                // Check for next page
                if (response.headers['x-ratelimit-remaining'] <= 10)
                {
                    console.warn(`API rate limit nearly depleted; rate limit remaining: ${response.headers['x-ratelimit-remaining']}`);
                    await new Promise(r => setTimeout(r, 15000));
                }
                const linkHeader = response.headers.link;
                const nextLink = linkHeader && linkHeader.split(',').find(link => link.includes('rel="next"'));
                url = nextLink ? nextLink.split(';')[0].slice(1, -1) : null;
            }
            
            stmt.finalize();
            let date = new Date();
            console.log(`Agents data refreshed: ${total} @ ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} ${date.getDate()}/${date.getMonth()}/${date.getFullYear()}`);
        } catch (err) {
            console.error('Error fetching agents:', err);
        }
    };

    const getBarcodesForRequesters = async (emails) => {
        try {
            await sql.connect(sqlConfig);
            const request = new sql.Request();
            const result = await request.query(`SELECT studentEmailAddress AS email, Barcode FROM vStudents WHERE studentEmailAddress IN ('${emails.join("','")}')`);
            const barcodes = {};
            result.recordset.forEach(record => {
                barcodes[record.email] = record.Barcode;
            });
            return barcodes;
        } catch (err) {
            console.error('Error fetching barcodes:', err);
            return {};
        }
    };

    const getPagersForRequesters = async () => {
        try {
            const response = await axios.get('http://localhost/fetch-ad-users');
            const users = response.data;
            const pagers = {};
            users.forEach(user => {
                if (user.email && user.pager) {
                    pagers[user.email] = user.pager;
                }
            });
            return pagers;
        } catch (err) {
            console.error('Error fetching pagers:', err);
            return {};
        }
    };

    // Refresh requesters and agents on startup
    Promise.all([refreshRequesters(), refreshAgents()]).then(() => {
        dbReady = true;

        console.log("Success! Access via: http://localhost:80");
    });

    // Refresh requesters and agents every 10 minutes
    setInterval(() => {
        refreshRequesters();
        refreshAgents();
    }, 10 * 60 * 1000);
});

app.get('/db-status', (req, res) => {
    res.json({ ready: dbReady });
});

// Endpoint to fetch users from multiple OUs in Active Directory
app.get('/fetch-ad-users', (req, res) => {
    const client = ldap.createClient({ url: adConfig.url });
    const users = [];
    const ous = [
        'OU=Students,DC=igssyd,DC=nsw,DC=edu,DC=au',
        'OU=Administrators,DC=igssyd,DC=nsw,DC=edu,DC=au',
        'OU=Staff,DC=igssyd,DC=nsw,DC=edu,DC=au'
    ];

    const fetchUsersFromOU = (ou, callback) => {
        const opts = {
            filter: '(objectClass=*)',
            scope: 'sub',
            attributes: ['userPrincipalName', 'pager'],
            paged: true,
            sizeLimit: 100
        };

        client.search(ou, opts, (err, res) => {
            if (err) {
                console.error('Error searching AD:', err);
                return callback(err);
            }

            res.on('searchEntry', (entry) => {
                const attributes = Object.fromEntries(entry.attributes.map(({ type, values }) => [type, values.length > 1 ? values : values[0]]));

                if (attributes['userPrincipalName'] && attributes['pager']) {
                    const userPrincipalName = attributes['userPrincipalName'];
                    const pagerAttribute = attributes['pager'];

                    users.push({ email: userPrincipalName, pager: pagerAttribute ? pagerAttribute : null });
                }
            });

            res.on('end', (result) => {
                callback(null);
            });

            res.on('error', (err) => {
                console.error('Error during AD search:', err);
                callback(err);
            });
        });
    };

    const fetchAllUsers = (ous, done) => {
        let index = 0;

        const next = () => {
            if (index < ous.length) {
                fetchUsersFromOU(ous[index], (err) => {
                    if (err) {
                        return done(err);
                    }
                    index++;
                    next();
                });
            } else {
                done(null);
            }
        };

        next();
    };

    client.bind(adConfig.username, adConfig.password, (err) => {
        if (err) {
            console.error('Error binding to AD:', err);
            return res.status(500).send('Error binding to AD');
        }

        fetchAllUsers(ous, (err) => {
            client.unbind();
            if (err) {
                return res.status(500).send('Error fetching AD users');
            }
            res.json(users);
        });
    });
});

app.get('/show-all-requesters', (req, res) => {
    const sqlQuery = `SELECT * FROM requesters`;
    db.all(sqlQuery, (err, rows) => {
        if (err) {
            console.error('Error querying requesters:', err);
            res.status(500).send('Error querying requesters');
        } else {
            res.json(rows);
        }
    });
});

app.post('/search-requesters', (req, res) => {
    const { query } = req.body;
    const sqlQuery = `
        SELECT *
        FROM requesters 
        WHERE 
        (
            first_name LIKE ? OR 
            last_name LIKE ? OR 
            display_name LIKE ? OR 
            primary_email LIKE ? OR
            barcode LIKE ? OR
            pager LIKE ?
        ) AND
        (
            primary_email LIKE '%@students.igssyd.nsw.edu.au' OR
            primary_email LIKE '%@igssyd.nsw.edu.au'
        )
        LIMIT 5
    `;
    const params = [`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`];

    db.all(sqlQuery, params, (err, rows) => {
        if (err) {
            console.error('Error querying requesters:', err);
            res.status(500).send('Error querying requesters');
        } else {
            res.json(rows);
        }
    });
});

app.get('/get-agents', (req, res) => {
    const sqlQuery = "SELECT * FROM agents WHERE department_name = 'ICT' AND email != 'freshservice@igssyd.nsw.edu.au' ORDER BY display_name;";
    db.all(sqlQuery, (err, rows) => {
        if (err) {
            console.error('Error querying agents:', err);
            res.status(500).send('Error querying agents');
        } else {
            res.json(rows);
        }
    });
});

app.post('/create-ticket', async (req, res) => {
    const { requester_id, subject, description, agent_id } = req.body;
    try {
        const response = await axios.post(`https://${freshserviceDomain}/api/v2/tickets`, {
            responder_id: Number(agent_id),
            requester_id: Number(requester_id),
            subject: subject,
            group_id: Number(76000095613),
            description: description,
            status: 2,
            priority: 1,
			source: 9
        }, authHeader);
        res.json(response.data);
    } catch (err) {
        console.error('Error creating ticket:', err);
        res.status(500).send('Error creating ticket');
    }
});

app.listen(80, () => {
    console.log('Server running on port 80: http://localhost:80');
});
