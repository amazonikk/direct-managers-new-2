/**
 * Direct Managers Dashboard API
 *
 * Приватні Google-таблиці залишаються приватними.
 * Web app працює від імені власника скрипта і повертає лише:
 * дата, чати, номери, назва акаунта/аркуша та платформа.
 */

const MANAGERS = [
  {
    id: "taya",
    name: "Тая",
    spreadsheetId: "1kjC6t8IMlipgE827-yqyJWUK0kZEU01gYxrNPn1sKSE"
  },
  {
    id: "kateryna",
    name: "Катерина",
    spreadsheetId: "1nLX2GGih9k6UJHDsH33_qK6IGquxzLGvWW7FQfMzt9Q"
  }
];

const DISPLAY_NAMES = {
  "РУ-tiktok": "TikTok — РУ",
  "УКР-tiktok": "TikTok — УКР",
  "legal-tiktok": "TikTok — Legal",
  "Рум - tiktok": "TikTok — Румунський",
  "Новинний - tiktok": "TikTok — Новинний",
  "РУ-inst": "Instagram — РУ",
  "УКР-inst": "Instagram — УКР",
  "legal-inst": "Instagram — Legal",
  "УЗБ - inst": "Instagram — УЗБ",
  "Новинний - inst": "Instagram — Новинний",
  "РУ-facebook": "Facebook — РУ",
  "ТЕЛЕГРАМ": "Telegram",

  "Ісп (cap) -tiktok": "TikTok — Іспанська (CAP)",
  "Marocco (europe)-tiktok": "TikTok — Марокко (Europe)",
  "Англ (e) - tiktok": "TikTok — Англійська (E)",
  "УЗБ (uz) - tiktok": "TikTok — Узбецька (UZ)",
  "Англ - INST": "Instagram — Англійська",
  "Англ - INST ": "Instagram — Англійська",
  "Рум - INST": "Instagram — Румунська",
  "Рум - INST ": "Instagram — Румунська",
  "УКР-facebook": "Facebook — Українська"
};

const HEADER_SCAN_ROWS = 8;

/**
 * Web app endpoint.
 * Підтримує:
 *   /exec                  -> JSON
 *   /exec?callback=myFunc  -> JSONP для GitHub Pages без CORS
 */
function doGet(e) {
  try {
    const report = buildReport_();
    return createResponse_(report, e);
  } catch (error) {
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      error: error && error.message ? error.message : String(error)
    };
    return createResponse_(payload, e);
  }
}

/**
 * Запусти цю функцію кнопкою "Uruchom", щоб один раз надати доступ
 * і перевірити, що обидві таблиці читаються.
 */
function testBackend() {
  const report = buildReport_();
  const accounts = report.managers.reduce(function(sum, manager) {
    return sum + manager.accounts.length;
  }, 0);
  const records = report.managers.reduce(function(sum, manager) {
    return sum + manager.accounts.reduce(function(inner, account) {
      return inner + account.records.length;
    }, 0);
  }, 0);

  Logger.log(JSON.stringify({
    generatedAt: report.generatedAt,
    managers: report.managers.length,
    accounts: accounts,
    records: records
  }, null, 2));

  return report;
}

function buildReport_() {
  const managers = MANAGERS.map(function(manager) {
    return parseManager_(manager);
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    managers: managers
  };
}

function parseManager_(manager) {
  const spreadsheet = SpreadsheetApp.openById(manager.spreadsheetId);
  const timezone = spreadsheet.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const accounts = [];
  const ignoredSheets = [];

  spreadsheet.getSheets().forEach(function(sheet) {
    try {
      const parsed = parseAccountSheet_(manager, sheet, timezone);
      if (parsed.account) {
        accounts.push(parsed.account);
      } else {
        ignoredSheets.push({
          sheet: sheet.getName(),
          reason: parsed.reason || "Аркуш не містить потрібних показників"
        });
      }
    } catch (error) {
      ignoredSheets.push({
        sheet: sheet.getName(),
        reason: error && error.message ? error.message : String(error)
      });
    }
  });

  accounts.sort(function(a, b) {
    return a.name.localeCompare(b.name, "uk");
  });

  return {
    id: manager.id,
    name: manager.name,
    spreadsheetId: manager.spreadsheetId,
    accounts: accounts,
    ignoredSheets: ignoredSheets
  };
}

function parseAccountSheet_(manager, sheet, timezone) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow < 1 || lastColumn < 1) {
    return { account: null, reason: "Порожній аркуш" };
  }

  const range = sheet.getRange(1, 1, lastRow, lastColumn);
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  const columnHeaders = [];
  for (let column = 0; column < lastColumn; column += 1) {
    const parts = [];
    const scanRows = Math.min(HEADER_SCAN_ROWS, lastRow);

    for (let row = 0; row < scanRows; row += 1) {
      const value = displayValues[row] && displayValues[row][column];
      if (value !== null && value !== undefined && String(value).trim() !== "") {
        parts.push(String(value));
      }
    }

    columnHeaders.push(normalizeText_(parts.join(" ")));
  }

  const dateColumn = findColumn_(columnHeaders, function(header) {
    return header.indexOf("дата") !== -1;
  });

  const resolvedDateColumn = dateColumn === null ? 0 : dateColumn;

  const totalChatsColumn = findColumn_(columnHeaders, function(header) {
    return header.indexOf("загальні чати") !== -1;
  });

  const totalNumbersColumn = findColumn_(columnHeaders, function(header) {
    return (
      header.indexOf("всього номерів разом") !== -1 ||
      header.indexOf("всього номерів") !== -1 ||
      header.indexOf("всего номеров") !== -1
    );
  });

  const chatColumns = totalChatsColumn !== null
    ? [totalChatsColumn]
    : findColumns_(columnHeaders, function(header) {
        return [
          "к сть чатів",
          "кількість чатів",
          "к сть звернень",
          "кількість звернень",
          "к сть написаних",
          "кількість написаних"
        ].some(function(pattern) {
          return header.indexOf(pattern) !== -1;
        });
      });

  if (!chatColumns.length || totalNumbersColumn === null) {
    return {
      account: null,
      reason: "Не знайдено одночасно колонки чатів і загальної кількості номерів"
    };
  }

  const recordsByDate = {};

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] || [];
    const displayRow = displayValues[rowIndex] || [];

    const dateIso = parseDateCell_(
      row[resolvedDateColumn],
      displayRow[resolvedDateColumn],
      timezone
    );

    if (!dateIso) continue;

    const chatValues = chatColumns.map(function(column) {
      return toNumber_(row[column], displayRow[column]);
    });

    const totalNumbersValue = toNumber_(
      row[totalNumbersColumn],
      displayRow[totalNumbersColumn]
    );

    let hasData;
    let chats;

    if (totalChatsColumn !== null) {
      hasData =
        chatValues[0] !== null ||
        (totalNumbersValue !== null && totalNumbersValue > 0);
      chats = chatValues[0] === null ? 0 : chatValues[0];
    } else {
      hasData =
        chatValues.some(function(value) { return value !== null; }) ||
        (totalNumbersValue !== null && totalNumbersValue > 0);

      chats = chatValues.reduce(function(sum, value) {
        return sum + (value === null ? 0 : value);
      }, 0);
    }

    if (!hasData) continue;

    const record = {
      date: dateIso,
      chats: roundMetric_(chats),
      numbers: roundMetric_(totalNumbersValue === null ? 0 : totalNumbersValue)
    };

    const previous = recordsByDate[dateIso];
    if (!previous || activityScore_(record) > activityScore_(previous)) {
      recordsByDate[dateIso] = record;
    }
  }

  const records = Object.keys(recordsByDate)
    .sort()
    .map(function(date) {
      return recordsByDate[date];
    });

  if (!records.length) {
    return {
      account: null,
      reason: "Немає рядків із датою та показниками"
    };
  }

  const sheetName = sheet.getName();

  return {
    account: {
      id: stableId_(manager.id, sheetName),
      sheetName: sheetName,
      name: DISPLAY_NAMES[sheetName] || prettifySheetName_(sheetName),
      platform: detectPlatform_(sheetName),
      records: records
    },
    reason: null
  };
}

function createResponse_(payload, e) {
  const callback = sanitizeCallback_(
    e && e.parameter ? e.parameter.callback : ""
  );
  const json = JSON.stringify(payload);

  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeCallback_(value) {
  const callback = String(value || "").trim();
  if (!callback) return "";
  return /^[A-Za-z_$][0-9A-Za-z_$\.]{0,100}$/.test(callback)
    ? callback
    : "";
}

function normalizeText_(value) {
  return String(value === null || value === undefined ? "" : value)
    .toLocaleLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn_(headers, predicate) {
  const index = headers.findIndex(predicate);
  return index === -1 ? null : index;
}

function findColumns_(headers, predicate) {
  const indexes = [];
  headers.forEach(function(header, index) {
    if (predicate(header)) indexes.push(index);
  });
  return indexes;
}

function parseDateCell_(rawValue, displayedValue, timezone) {
  if (
    Object.prototype.toString.call(rawValue) === "[object Date]" &&
    !isNaN(rawValue.getTime())
  ) {
    return Utilities.formatDate(rawValue, timezone, "yyyy-MM-dd");
  }

  if (typeof rawValue === "number" && isFinite(rawValue) && rawValue > 20000) {
    const milliseconds = Math.round((rawValue - 25569) * 86400000);
    const date = new Date(milliseconds);
    return Utilities.formatDate(date, "UTC", "yyyy-MM-dd");
  }

  const candidates = [displayedValue, rawValue];

  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index];
    if (value === null || value === undefined) continue;

    const text = String(value)
      .replace(/[\u00A0\u202F]/g, " ")
      .trim()
      .replace(/\s+/g, "");

    if (!text) continue;

    let match = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (match) {
      return validIso_(
        Number(match[3]),
        Number(match[2]),
        Number(match[1])
      );
    }

    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      return validIso_(
        Number(match[1]),
        Number(match[2]),
        Number(match[3])
      );
    }
  }

  return null;
}

function validIso_(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function toNumber_(rawValue, displayedValue) {
  if (typeof rawValue === "number" && isFinite(rawValue)) {
    return rawValue;
  }

  const candidates = [displayedValue, rawValue];

  for (let index = 0; index < candidates.length; index += 1) {
    const value = candidates[index];
    if (typeof value !== "string") continue;

    const text = value
      .replace(/[\u00A0\u202F\s]/g, "")
      .replace(/%$/, "")
      .replace(",", ".");

    if (!text || text === "-" || /^#/.test(text)) continue;

    const number = Number(text);
    if (isFinite(number)) return number;
  }

  return null;
}

function activityScore_(record) {
  return Math.abs(record.chats) + Math.abs(record.numbers) * 10;
}

function roundMetric_(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function stableId_(managerId, sheetName) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    managerId + ":" + sheetName,
    Utilities.Charset.UTF_8
  );

  const hash = bytes
    .slice(0, 6)
    .map(function(byte) {
      return ((byte + 256) % 256).toString(16).padStart(2, "0");
    })
    .join("");

  return managerId + "-" + hash;
}

function prettifySheetName_(sheetName) {
  return String(sheetName)
    .trim()
    .replace(/\s*[-–]\s*/g, " — ")
    .replace(/\s+/g, " ");
}

function detectPlatform_(sheetName) {
  const normalized = normalizeText_(sheetName);

  if (normalized.indexOf("tiktok") !== -1) return "TikTok";
  if (normalized.indexOf("inst") !== -1) return "Instagram";
  if (
    normalized.indexOf("facebook") !== -1 ||
    normalized.indexOf("фб") !== -1
  ) {
    return "Facebook";
  }
  if (normalized.indexOf("телеграм") !== -1) return "Telegram";
  if (normalized.indexOf("ютуб") !== -1 || normalized.indexOf("youtube") !== -1) {
    return "YouTube";
  }
  if (normalized.indexOf("пошта") !== -1 || normalized.indexOf("mail") !== -1) {
    return "Email";
  }

  return "Інше";
}
