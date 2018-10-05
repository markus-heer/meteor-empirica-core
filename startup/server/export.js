import moment from "moment";
import archiver from "archiver";
import streams from "stream-buffers";
import contentDisposition from "content-disposition";

import { Factors } from "../../api/factors/factors.js";
import { FactorTypes } from "../../api/factor-types/factor-types.js";
import { LobbyConfigs } from "../../api/lobby-configs/lobby-configs.js";
import { Batches } from "../../api/batches/batches.js";
import { Games } from "../../api/games/games.js";
import { GameLobbies } from "../../api/game-lobbies/game-lobbies.js";
import { PlayerInputs } from "../../api/player-inputs/player-inputs.js";
import { PlayerRounds } from "../../api/player-rounds/player-rounds.js";
import { PlayerStages } from "../../api/player-stages/player-stages.js";
import { Players } from "../../api/players/players.js";
import { Rounds } from "../../api/rounds/rounds.js";
import { Stages } from "../../api/stages/stages.js";
import { Treatments } from "../../api/treatments/treatments.js";
import LRUMap from "../../lib/lru.js";
import log from "../../lib/log.js";

export const BOM = "\uFEFF";

// Get all possible keys in the data field of collections that have a data field
// such as Players, PlayerStages and PlayerRounds.
const getDataKeys = coll => {
  const map = {};
  coll.find({}, { fields: { data: 1 } }).forEach(record => {
    _.keys(record.data).forEach(key => (map[key] = true));
  });
  return _.keys(map);
};

export const cast = out => {
  if (_.isArray(out)) {
    // The cast here will flatten arrays but will still catch dates correctly
    return out.map(a => cast(a)).join(",");
  }
  if (_.isDate(out)) {
    return moment(out)
      .utc()
      .format();
  }
  if (_.isObject(out)) {
    return JSON.stringify(out);
  }
  if (_.isString(out)) {
    return out.replace(/\n/g, "\\n");
  }

  if (out === false || out === 0) {
    return out.toString();
  }
  return (out || "").toString();
};

export const quoteMark = '"';
export const doubleQuoteMark = '""';
export const quoteRegex = /"/g;

export const encodeCells = (line, delimiter = ",", newline = "\\n") => {
  const row = line.slice(0);
  for (var i = 0, len = row.length; i < len; i++) {
    row[i] = cast(row[i]);
    if (row[i].indexOf(quoteMark) !== -1) {
      row[i] = row[i].replace(quoteRegex, doubleQuoteMark);
    }
    if (row[i].indexOf(delimiter) !== -1 || row[i].indexOf(newline) !== -1) {
      row[i] = quoteMark + row[i] + quoteMark;
    }
  }
  return row.join(delimiter) + newline;
};

const batch = (coll, query = {}, sort = {}, limit = 1000) => iterator => {
  let skip = 0,
    records;
  while (!records || records.length > 0) {
    records = coll.find(query, { sort, limit, skip }).fetch();
    records.forEach(iterator);
    skip += limit;
  }
};

WebApp.connectHandlers.use("/admin/export", (req, res, next) => {
  //
  // Authentication
  //

  const loginToken = req.cookies && req.cookies.meteor_login_token;
  let user;
  if (loginToken) {
    const hashedToken = Accounts._hashLoginToken(loginToken);
    const query = { "services.resume.loginTokens.hashedToken": hashedToken };
    const options = { fields: { _id: 1 } };
    user = Meteor.users.findOne(query, options);
  }

  if (!user) {
    res.writeHead(403);
    res.end();
    return;
  }

  //
  // Format
  //

  let format;
  switch (req.url) {
    case "/":
      next();
      return;
    case "/.json":
      format = "json";
      break;
    case "/.csv":
      format = "csv";
      break;
    default:
      res.writeHead(404);
      res.end();
      return;
  }

  //
  // Connection bookkeeping
  //

  let cancelRequest = false,
    requestFinished = false;

  req.on("close", function(err) {
    if (!requestFinished) {
      log.info("Export request was cancelled");
      cancelRequest = true;
    }
  });

  //
  // Headers
  //

  const ts = moment().format("YYYY-MM-DD HH-mm-ss");
  const filename = `Empirica Data - ${ts}`;
  res.setHeader("Content-Disposition", contentDisposition(filename + ".zip"));
  res.setHeader("Content-Type", "application/zip");
  res.writeHead(200);

  //
  // Create archive
  //

  var archive = archiver("zip");

  // good practice to catch warnings (ie stat failures and other non-blocking errors)
  archive.on("warning", function(err) {
    if (err.code === "ENOENT") {
      log.warn("archive warning", err);
    } else {
      log.err("archive error");
      // throw error
      throw err;
    }
  });

  // good practice to catch this error explicitly
  archive.on("error", function(err) {
    log.err("archive error");
    throw err;
  });

  // pipe archive data to the file
  archive.pipe(res);

  //
  // File creation helper
  //

  const existingFile = {};
  const saveFile = (name, keys, func, dataKeys = []) => {
    if (existingFile[name]) {
      throw `export filename already exists: ${name}`;
    }
    existingFile[name] = true;

    const file = new streams.ReadableStreamBuffer();
    archive.append(file, { name: `${filename}/${name}.${format}` });
    if (format === "csv") {
      file.put(BOM);
      file.put(encodeCells(keys.concat(dataKeys.map(k => `data.${k}`))));
    }
    func((data, userData = {}) => {
      switch (format) {
        case "csv":
          const out = [];
          keys.forEach(k => {
            out.push(data[k]);
          });
          dataKeys.forEach(k => {
            out.push(userData[k]);
          });
          file.put(encodeCells(out));
          break;
        case "json":
          _.each(userData, (v, k) => (data[`data.${k}`] = v));
          file.put(JSON.stringify(data) + "\n");
          break;
        default:
          throw `unknown format: ${format}`;
      }
    });
    file.stop();
  };

  //
  // Exports
  //

  const factorTypeFields = [
    "_id",
    "name",
    "required",
    "description",
    "type",
    "min",
    "max",
    "createdAt",
    "archivedAt"
  ];
  saveFile("factor-types", factorTypeFields, puts => {
    FactorTypes.find().forEach(ft => puts(_.pick(ft, factorTypeFields)));
  });

  const factorFields = ["_id", "name", "value", "factorTypeId", "createdAt"];
  saveFile("factors", factorFields, puts => {
    batch(Factors)(f => puts(_.pick(f, factorFields)));
  });

  const treatmentFields = [
    "_id",
    "name",
    "factorIds",
    "createdAt",
    "archivedAt"
  ];
  saveFile("treatments", treatmentFields, puts => {
    batch(Treatments)(f => puts(_.pick(f, treatmentFields)));
  });

  const lobbyConfigFields = [
    "_id",
    "name",
    "timeoutType",
    "timeoutInSeconds",
    "timeoutStrategy",
    "timeoutBots",
    "extendCount",
    "createdAt",
    "archivedAt"
  ];
  saveFile("lobby-configs", lobbyConfigFields, puts => {
    batch(LobbyConfigs)(f => puts(_.pick(f, lobbyConfigFields)));
  });

  const batchFields = [
    "_id",
    "assignment",
    "full",
    "runningAt",
    "finishedAt",
    "status",
    "gameIds",
    "gameLobbyIds",
    "createdAt",
    "archivedAt"
  ];
  saveFile("batches", batchFields, puts => {
    batch(Batches)(f => puts(_.pick(f, batchFields)));
  });

  const gameLobbyFields = [
    "_id",
    "index",
    "availableCount",
    "timeoutStartedAt",
    "timedOutAt",
    "queuedPlayerIds",
    "playerIds",
    "gameId",
    "treatmentId",
    "batchId",
    "lobbyConfigId",
    "createdAt"
  ];
  saveFile("game-lobbies", gameLobbyFields, puts => {
    batch(GameLobbies)(f => puts(_.pick(f, gameLobbyFields)));
  });

  const gameFields = [
    "_id",
    "finishedAt",
    "gameLobbyId",
    "treatmentId",
    "roundIds",
    "playerIds",
    "batchId",
    "createdAt"
  ];
  const gameDataFields = getDataKeys(Games);
  saveFile(
    "games",
    gameFields,
    puts => {
      batch(Games)(f => puts(_.pick(f, gameFields), _.pick(f, gameDataFields)));
    },
    gameDataFields
  );

  const playerFields = [
    "_id",
    "id",
    "urlParams",
    "bot",
    "readyAt",
    "timeoutStartedAt",
    "timeoutWaitCount",
    "exitStepsDone",
    "exitAt",
    "exitStatus",
    "retiredAt",
    "retiredReason",
    "createdAt"
  ];
  const playerDataFields = getDataKeys(Players);
  saveFile(
    "players",
    playerFields,
    puts => {
      batch(Players)(p =>
        puts(_.pick(p, playerFields), _.pick(p.data, playerDataFields))
      );
    },
    playerDataFields
  );

  const roundFields = ["_id", "index", "stageIds", "gameId", "createdAt"];
  const roundDataFields = getDataKeys(Rounds);
  saveFile(
    "rounds",
    roundFields,
    puts => {
      batch(Rounds)(p =>
        puts(_.pick(p, roundFields), _.pick(p.data, roundDataFields))
      );
    },
    roundDataFields
  );

  const stageFields = [
    "_id",
    "index",
    "name",
    "displayName",
    "startTimeAt",
    "durationInSeconds",
    "roundId",
    "gameId",
    "createdAt"
  ];
  const stageDataFields = getDataKeys(Stages);
  saveFile(
    "stages",
    stageFields,
    puts => {
      batch(Stages)(p =>
        puts(_.pick(p, stageFields), _.pick(p.data, stageDataFields))
      );
    },
    stageDataFields
  );

  const playerRoundFields = [
    "_id",
    "batchId",
    "playerId",
    "roundId",
    "gameId",
    "createdAt"
  ];
  const playerRoundDataFields = getDataKeys(PlayerRounds);
  saveFile(
    "player-rounds",
    playerRoundFields,
    puts => {
      batch(PlayerRounds)(p =>
        puts(
          _.pick(p, playerRoundFields),
          _.pick(p.data, playerRoundDataFields)
        )
      );
    },
    playerRoundDataFields
  );

  const playerStageFields = [
    "_id",
    "batchId",
    "playerId",
    "stageId",
    "roundId",
    "gameId",
    "createdAt"
  ];
  const playerStageDataFields = getDataKeys(PlayerStages);
  saveFile(
    "player-stages",
    playerStageFields,
    puts => {
      batch(PlayerStages)(p =>
        puts(
          _.pick(p, playerStageFields),
          _.pick(p.data, playerStageDataFields)
        )
      );
    },
    playerStageDataFields
  );

  const playerInputFields = ["_id", "playerId", "gameId", "createdAt"];
  const playerInputDataFields = getDataKeys(PlayerInputs);
  saveFile(
    "player-inputs",
    playerInputFields,
    puts => {
      batch(PlayerInputs)(p =>
        puts(
          _.pick(p, playerInputFields),
          _.pick(p.data, playerInputDataFields)
        )
      );
    },
    playerInputDataFields
  );

  archive.finalize();
  requestFinished = true;
});
