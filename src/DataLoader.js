/*
 * This file is a part of "NMIG" - the database migration tool.
 *
 * Copyright (C) 2016 - present, Anatoly Khaytovich <anatolyuss@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program (please see the "LICENSE.md" file).
 * If not, see <http://www.gnu.org/licenses/gpl.txt>.
 *
 * @author Anatoly Khaytovich <anatolyuss@gmail.com>
 */
'use strict';

const path                   = require('path');
const { from }               = require('pg-copy-streams');
const csvStringify           = require('./CsvStringifyModified');
const log                    = require('./Logger');
const generateError          = require('./ErrorGenerator');
const connect                = require('./Connector');
const Conversion             = require('./Classes/Conversion');
const MessageToMaster        = require('./Classes/MessageToMaster');
const { enforceConsistency } = require('./ConsistencyEnforcer');
const extraConfigProcessor   = require('./ExtraConfigProcessor');
const BufferStream           = require('./Classes/BufferStream');

process.on('message', signal => {
    const self     = new Conversion(signal.config);
    const promises = [];
    log(self, '\t--[loadData] Loading the data...');

    for (let i = 0; i < signal.chunks.length; ++i) {
        promises.push(
            connect(self).then(() => {
                return enforceConsistency(self, signal.chunks[i]);
            }).then(isNormalFlow => {
                if (isNormalFlow) {
                    return populateTableWorker(
                        self,
                        signal.chunks[i]._tableName,
                        signal.chunks[i]._selectFieldList,
                        signal.chunks[i]._offset,
                        signal.chunks[i]._rowsInChunk,
                        signal.chunks[i]._rowsCnt,
                        signal.chunks[i]._id
                    );
                }

                return deleteChunk(self, signal.chunks[i]._id);
            })
        );
    }

    Promise.all(promises).then(() => process.send('processed'));
});

/**
 * Delete given record from the data-pool.
 *
 * @param {Conversion}               self
 * @param {Number}                   dataPoolId
 * @param {Node-pg client|undefined} client
 * @param {Function|undefined}       done
 *
 * @returns {Promise}
 */
const deleteChunk = (self, dataPoolId, client, done) => {
    return new Promise(resolve => {
        if (client) {
            const sql = 'DELETE FROM "' + self._schema + '"."data_pool_' + self._schema + self._mySqlDbName
                + '" ' + 'WHERE id = ' + dataPoolId + ';';

            client.query(sql, err => {
                done();

                if (err) {
                    generateError(self, '\t--[deleteChunk] ' + err, sql);
                }

                resolve();
            });
        } else {
            self._pg.connect((error, client, done) => {
                if (error) {
                    generateError(self, '\t--[deleteChunk] Cannot connect to PostgreSQL server...\n' + error);
                    resolve();
                } else {
                    const sql = 'DELETE FROM "' + self._schema + '"."data_pool_' + self._schema + self._mySqlDbName
                        + '" ' + 'WHERE id = ' + dataPoolId + ';';

                    client.query(sql, err => {
                        done();

                        if (err) {
                            generateError(self, '\t--[deleteChunk] ' + err, sql);
                        }

                        resolve();
                    });
                }
            });
        }
    });
};

/**
 * Build a MySQL query to retrieve the chunk of data.
 *
 * @param {String} tableName
 * @param {String} strSelectFieldList
 * @param {Number} offset
 * @param {Number} rowsInChunk
 *
 * @returns {String}
 */
const buildChunkQuery = (tableName, strSelectFieldList, offset, rowsInChunk) => {
    return 'SELECT ' + strSelectFieldList + ' FROM `' + tableName + '` LIMIT ' + offset + ',' + rowsInChunk + ';';
};

/**
 * Process data-loading error.
 *
 * @param {Conversion}               self
 * @param {String}                   streamError
 * @param {String}                   sql
 * @param {String}                   sqlCopy
 * @param {String}                   tableName
 * @param {Number}                   dataPoolId
 * @param {Node-pg client|undefined} client
 * @param {Function|undefined}       done
 * @param {Function}                 callback
 *
 * @returns {undefined}
 */
const processDataError = (self, streamError, sql, sqlCopy, tableName, dataPoolId, client, done, callback) => {
    generateError(self, '\t--[populateTableWorker] ' + streamError, sqlCopy);
    const rejectedData = '\t--[populateTableWorker] Error loading table data:\n' + sql + '\n';
    log(self, rejectedData, path.join(self._logsDirPath, tableName + '.log'));
    deleteChunk(self, dataPoolId, client, done).then(() => callback());
};

/**
 * Load a chunk of data using "PostgreSQL COPY".
 *
 * @param {Conversion} self
 * @param {String}     tableName
 * @param {String}     strSelectFieldList
 * @param {Number}     offset
 * @param {Number}     rowsInChunk
 * @param {Number}     rowsCnt
 * @param {Number}     dataPoolId
 *
 * @returns {Promise}
 */
const populateTableWorker = (self, tableName, strSelectFieldList, offset, rowsInChunk, rowsCnt, dataPoolId) => {
    return new Promise(resolvePopulateTableWorker => {
        self._mysql.getConnection((error, connection) => {
            if (error) {
                // The connection is undefined.
                generateError(self, '\t--[populateTableWorker] Cannot connect to MySQL server...\n\t' + error);
                resolvePopulateTableWorker();
            } else {
                const originalTableName = extraConfigProcessor.getTableName(self, tableName, true);
                const sql               = buildChunkQuery(originalTableName, strSelectFieldList, offset, rowsInChunk);

                connection.query(sql, (err, rows) => {
                    connection.release();

                    if (err) {
                        generateError(self, '\t--[populateTableWorker] ' + err, sql);
                        resolvePopulateTableWorker();
                    } else {
                        rowsInChunk                                                             = rows.length;
                        rows[0][self._schema + '_' + originalTableName + '_data_chunk_id_temp'] = dataPoolId;

                        csvStringify(rows, (csvError, csvString) => {
                            rows = null;

                            if (csvError) {
                                generateError(self, '\t--[populateTableWorker] ' + csvError);
                                resolvePopulateTableWorker();
                            } else {
                                const buffer = Buffer.from(csvString, self._encoding);
                                csvString  = null;

                                self._pg.connect((error, client, done) => {
                                    if (error) {
                                        generateError(self, '\t--[populateTableWorker] Cannot connect to PostgreSQL server...\n' + error, sql);
                                        resolvePopulateTableWorker();
                                    } else {
                                        const sqlCopy      = 'COPY "' + self._schema + '"."' + tableName + '" FROM STDIN DELIMITER \'' + self._delimiter + '\' CSV;';
                                        const copyStream   = client.query(from(sqlCopy));
                                        const bufferStream = new BufferStream(buffer);

                                        copyStream.on('end', () => {
                                            /*
                                             * COPY FROM STDIN does not return the number of rows inserted.
                                             * But the transactional behavior still applies (no records inserted if at least one failed).
                                             * That is why in case of 'on end' the rowsInChunk value is actually the number of records inserted.
                                             */
                                            process.send(new MessageToMaster(tableName, rowsInChunk, rowsCnt));
                                            deleteChunk(self, dataPoolId, client, done).then(() => resolvePopulateTableWorker());
                                        });

                                        copyStream.on('error', copyStreamError => {
                                            processDataError(
                                                self,
                                                copyStreamError,
                                                sql,
                                                sqlCopy,
                                                tableName,
                                                dataPoolId,
                                                client,
                                                done,
                                                resolvePopulateTableWorker
                                            );
                                        });

                                        bufferStream.on('error', bufferStreamError => {
                                            processDataError(
                                                self,
                                                bufferStreamError,
                                                sql,
                                                sqlCopy,
                                                tableName,
                                                dataPoolId,
                                                client,
                                                done,
                                                resolvePopulateTableWorker
                                            );
                                        });

                                        bufferStream
                                            .setEncoding(self._encoding)
                                            .pipe(copyStream);
                                    }
                                });
                            }
                        }, self._encoding);
                    }
                });
            }
        });
    });
};
