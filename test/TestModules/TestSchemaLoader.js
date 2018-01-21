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

const mysql                                 = require('mysql');
const fs                                    = require('fs');
const path                                  = require('path');
const Main                                  = require('../../src/Main');
const SchemaProcessor                       = require('../../src/SchemaProcessor');
const ConnectionEmitter                     = require('../../src/ConnectionEmitter');
const readDataTypesMap                      = require('../../src/DataTypesMapReader');
const Conversion                            = require('../../src/Classes/Conversion');
const loadStructureToMigrate                = require('../../src/StructureLoader');
const pipeData                              = require('../../src/DataPipeManager');
const boot                                  = require('../../src/BootProcessor');
const { createStateLogsTable }              = require('../../src/MigrationStateManager');
const { createDataPoolTable, readDataPool } = require('../../src/DataPoolManager');
const log                                   = require('../../src/Logger');

module.exports = class TestSchemaLoader {

    /**
     * TestSchemaLoader constructor.
     */
    constructor() {
        this._app        = new Main();
        this._conversion = null;
    }

    /**
     * Creates test source database.
     *
     * @param {Conversion} conversion
     *
     * @returns {Promise<Conversion>}
     */
    createTestSourceDb(conversion) {
        return new Promise(resolve => {
            const sourceDbName = 'test_source_db';
            const sql          = `CREATE DATABASE IF NOT EXISTS ${ sourceDbName };`;
            const connection   = mysql.createConnection(conversion._sourceConString);
            connection.connect();

            connection.query(sql, error => {
                if (error) {
                    // Failed to create test source database.
                    console.log(error);
                    process.exit();
                }

                connection.end();
                conversion._sourceConString.database = sourceDbName;
                resolve(conversion);
            });
        });
    }

    /**
     * Loads test schema.
     *
     * @returns {undefined}
     */
    loadTestSchema() {
        const baseDir = path.join(__dirname, '..', '..');

        this._app.readConfig(baseDir, 'test_config.json')
            .then(config => {
                return this._app.readExtraConfig(config, baseDir);
            })
            .then(this._app.initializeConversion)
            .then(this.createTestSourceDb)
            .then(readDataTypesMap)
            .then(this._app.createLogsDirectory)
            .then(conversion => {
                return (new SchemaProcessor(conversion)).createSchema();
            })
            .then(createStateLogsTable)
            .then(createDataPoolTable)
            .then(loadStructureToMigrate)
            .then(readDataPool)
            .then(pipeData)
            .catch(error => console.log(error));
    }
};