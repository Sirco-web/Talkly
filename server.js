// server.js - Talky with GitHub-backed storage + encrypted chats (Calls Removed)
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");

// Add a portable fetch reference (Node >=18 has global fetch; fallback to undici)
let fetch = globalThis.fetch;
if (!fetch) {
  try {
    fetch = require("undici").fetch;
  } catch (e) {
    console.error(
      "Fetch API not available. Install 'undici' (npm install undici) or run Node >=18."
    );
    throw e;
  }
}

const app = express();

// Trust proxy is required to get the real IP if behind a reverse proxy (common in dev containers/cloud)
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const DATA_PATH = process.env.DATA_PATH || "talky/data.json";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-admin-pass";

// --- Presence System (In-Memory) ---
const userPresence = {}; // { userId: { status: 'online'|'away', lastSeen: number, ip: string } }

// Cleanup stale presence every 10 seconds
setInterval(() => {
  const now = Date.now();
  for (const uid in userPresence) {
    if (now - userPresence[uid].lastSeen > 30000) { // 30s timeout
      delete userPresence[uid];
    }
  }
}, 10000);

// --- Security & Signup Logic ---
// Removed IP-based map
let currentSignupCode = generateSignupCode();

// Rotate code every hour
setInterval(() => {
  currentSignupCode = generateSignupCode();
}, 60 * 60 * 1000);

function generateSignupCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const emojis = [
    "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "☺️", "😚", "😙",
    "🥲", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏", "😒", "🙄", "😬", "🤥",
    "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🤧", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐",
    "😕", "😟", "🙁", "☹️", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞", "😓",
    "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "😈", "👿", "💀", "☠️", "💩", "🤡", "👹", "👺", "👻", "👽", "👾", "🤖", "😺", "😸",
    "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "🙈", "🙉", "🙊", "💋", "💌", "💘", "💝", "💖", "💗", "💓", "💞", "💕", "💟", "❣️",
    "💔", "❤️", "🧡", "💛", "💚", "💙", "💜", "🤎", "🖤", "🤍", "💯", "💢", "💥", "💫", "💦", "💨", "🕳️", "💣", "💬", "👁️‍🗨️", "🗨️",
    "🗯️", "💭", "💤", "👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "🖕", "👇",
    "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✍️", "💅", "🤳", "💪", "🦾", "🦿", "🦵", "🦶",
    "👂", "🦻", "👃", "🧠", "🫀", "🫁", "🦷", "🦴", "👀", "👁️", "👅", "👄", "👶", "🧒", "👦", "👧", "🧑", "👱", "👨", "🧔", "👨‍🦰",
    "👨‍🦱", "👨‍🦳", "👨‍🦲", "👩", "👩‍🦰", "👩‍🦱", "👩‍🦳", "👩‍🦲", "👱‍♀️", "👱‍♂️", "🧓", "👴", "👵", "🙍", "🙍‍♂️", "🙍‍♀️", "🙎", "🙎‍♂️", "🙎‍♀️",
    "🙅", "🙅‍♂️", "🙅‍♀️", "🙆", "🙆‍♂️", "🙆‍♀️", "💁", "💁‍♂️", "💁‍♀️", "🙋", "🙋‍♂️", "🙋‍♀️", "🧏", "🧏‍♂️", "🧏‍♀️", "🙇", "🙇‍♂️", "🙇‍♀️",
    "🤦", "🤦‍♂️", "🤦‍♀️", "🤷", "🤷‍♂️", "🤷‍♀️", "👨‍⚕️", "👩‍⚕️", "👨‍🎓", "👩‍🎓", "👨‍🏫", "👩‍🏫", "👨‍⚖️", "👩‍⚖️", "👨‍🌾", "👩‍🌾", "👨‍🍳", "👩‍🍳",
    "👨‍🔧", "👩‍🔧", "👨‍🏭", "👩‍🏭", "👨‍💼", "👩‍💼", "👨‍🔬", "👩‍🔬", "👨‍💻", "👩‍💻", "👨‍🎤", "👩‍🎤", "👨‍🎨", "👩‍🎨", "👨‍✈️", "👩‍✈️", "👨‍🚀", "👩‍🚀",
    "👨‍🚒", "👩‍🚒", "👮", "👮‍♂️", "👮‍♀️", "🕵️", "🕵️‍♂️", "🕵️‍♀️", "💂", "💂‍♂️", "💂‍♀️", "🥷", "👷", "👷‍♂️", "👷‍♀️", "🤴", "👸", "👳", "👳‍♂️",
    "👳‍♀️", "👲", "🧕", "🤵", "🤵‍♂️", "🤵‍♀️", "👰", "👰‍♂️", "👰‍♀️", "🤰", "🤱", "👩‍🍼", "👨‍🍼", "👼", "🎅", "🤶", "🧑‍🎄", "🦸", "🦸‍♂️", "🦸‍♀️",
    "🦹", "🦹‍♂️", "🦹‍♀️", "🧙", "🧙‍♂️", "🧙‍♀️", "🧚", "🧚‍♂️", "🧚‍♀️", "🧛", "🧛‍♂️", "🧛‍♀️", "🧜", "🧜‍♂️", "🧜‍♀️", "🧝", "🧝‍♂️", "🧝‍♀️", "🧞",
    "🧞‍♂️", "🧞‍♀️", "🧟", "🧟‍♂️", "🧟‍♀️", "💆", "💆‍♂️", "💆‍♀️", "💇", "💇‍♂️", "💇‍♀️", "🚶", "🚶‍♂️", "🚶‍♀️", "🧍", "🧍‍♂️", "🧍‍♀️", "🧎", "🧎‍♂️",
    "🧎‍♀️", "👨‍🦯", "👩‍🦯", "👨‍🦼", "👩‍🦼", "👨‍🦽", "👩‍🦽", "🏃", "🏃‍♂️", "🏃‍♀️", "💃", "🕺", "🕴️", "👯", "👯‍♂️", "👯‍♀️", "🧖", "🧖‍♂️", "🧖‍♀️",
    "🧗", "🧗‍♂️", "🧗‍♀️", "🤺", "🏇", "⛷️", "🏂", "🏌️", "🏌️‍♂️", "🏌️‍♀️", "🏄", "🏄‍♂️", "🏄‍♀️", "🚣", "🚣‍♂️", "🚣‍♀️", "🏊", "🏊‍♂️", "🏊‍♀️",
    "⛹️", "⛹️‍♂️", "⛹️‍♀️", "🏋️", "🏋️‍♂️", "🏋️‍♀️", "🚴", "🚴‍♂️", "🚴‍♀️", "🚵", "🚵‍♂️", "🚵‍♀️", "🤸", "🤸‍♂️", "🤸‍♀️", "🤼", "🤼‍♂️", "🤼‍♀️",
    "🤽", "🤽‍♂️", "🤽‍♀️", "🤾", "🤾‍♂️", "🤾‍♀️", "🤹", "🤹‍♂️", "🤹‍♀️", "🧘", "🧘‍♂️", "🧘‍♀️", "🛀", "🛌", "👭", "👫", "👬", "💏", "👩‍❤️‍💋‍👨",
    "👨‍❤️‍💋‍👨", "👩‍❤️‍💋‍👩", "💑", "👩‍❤️‍👨", "👨‍❤️‍👨", "👩‍❤️‍👩", "👪", "👨‍👩‍👦", "👨‍👩‍👧", "👨‍👩‍👧‍👦", "👨‍👩‍👦‍👦", "👨‍👩‍👧‍👧", "👨‍👨‍👦", "👨‍👨‍👧",
    "👨‍👨‍👧‍👦", "👨‍👨‍👦‍👦", "👨‍👨‍👧‍👧", "👩‍👩‍👦", "👩‍👩‍👧", "👩‍👩‍👧‍👦", "👩‍👩‍👦‍👦", "👩‍👩‍👧‍👧", "👨‍👦", "👨‍👦‍👦", "👨‍👧", "👨‍👧‍👦", "👨‍👧‍👧", "👩‍👦", "👩‍👦‍👦",
    "👩‍👧", "👩‍👧‍👦", "👩‍👧‍👧", "🗣️", "👤", "👥", "🫂", "👣", "🐵", "🐒", "🦍", "🦧", "🐶", "🐕", "🦮", "🐕‍🦺", "🐩", "🐺", "🦊", "🦝",
    "🐱", "🐈", "🐈‍⬛", "🦁", "🐯", "🐅", "🐆", "🐴", "🐎", "🦄", "🦓", "🦌", "🦬", "🐮", "🐂", "🐃", "🐄", "🐷", "🐖", "🐗", "🐽",
    "🐏", "🐑", "🐐", "🐪", "🐫", "🦙", "🦒", "🐘", "🦣", "🦏", "🦛", "🐭", "🐁", "🐀", "🐹", "🐰", "🐇", "🐿️", "🦫", "🦔", "🦇",
    "🐻", "🐻‍❄️", "🐨", "🐼", "🦥", "🦦", "🦨", "🦘", "🦡", "🐾", "🦃", "🐔", "🐓", "🐣", "🐤", "🐥", "🐦", "🐧", "🕊️", "🦅",
    "🦆", "🦢", "🦉", "🦤", "🪶", "🦩", "🦚", "🦜", "🐸", "🐊", "🐢", "🦎", "🐍", "🐲", "🐉", "🦕", "🦖", "🐳", "🐋", "🐬", "🦭",
    "🐟", "🐠", "🐡", "🦈", "🐙", "🐚", "🐌", "🦋", "🐛", "🐜", "🐝", "🪲", "🐞", "🦗", "🪳", "🕷️", "🕸️", "🦂", "🦟", "🪰", "🪱",
    "🦠", "💐", "🌸", "💮", "🏵️", "🌹", "🥀", "🌺", "🌻", "🌼", "🌷", "🌱", "🪴", "🌲", "🌳", "🌴", "🌵", "🌾", "🌿", "☘️", "🍀",
    "🍁", "🍂", "🍃", "🍇", "🍈", "🍉", "🍊", "🍋", "🍌", "🍍", "🥭", "🍎", "🍏", "🍐", "🍑", "🍒", "🍓", "🫐", "🥝", "🍅", "🫒",
    "🥥", "🥑", "🍆", "🥔", "🥕", "🌽", "🌶️", "🫑", "🥒", "🥬", "🥦", "🧄", "🧅", "🍄", "🥜", "🌰", "🍞", "🥐", "🥖", "🫓", "🥨",
    "🥯", "🥞", "🧇", "🧀", "🍖", "🍗", "🥩", "🥓", "🍔", "🍟", "🍕", "🌭", "🥪", "🌮", "🌯", "🫔", "🥙", "🧆", "🥚", "🍳", "🥘",
    "🍲", "🫕", "🥣", "🥗", "🍿", "🧈", "🧂", "🥫", "🍱", "🍘", "🍙", "🍚", "🍛", "🍜", "🍝", "🍠", "🍢", "🍣", "🍤", "🍥", "🥮",
    "🍡", "🥟", "🥠", "🥡", "🦀", "🦞", "🦐", "🦑", "🦪", "🍦", "🍧", "🍨", "🍩", "🍪", "🎂", "🍰", "🧁", "🥧", "🍫", "🍬", "🍭",
    "🍮", "🍯", "🍼", "🥛", "☕", "🫖", "🍵", "🍶", "🍾", "🍷", "🍸", "🍹", "🍺", "🍻", "🥂", "🥃", "🥤", "🧋", "🧃", "🧉", "🧊",
    "🥢", "🍽️", "🍴", "🥄", "🔪", "🏺", "🌍", "🌎", "🌏", "🌐", "🗺️", "🗾", "🧭", "🏔️", "⛰️", "🌋", "🗻", "🏕️", "🏖️", "🏜️", "🏝️",
    "🏞️", "🏟️", "🏛️", "🏗️", "🧱", "🪨", "🪵", "🛖", "🏘️", "🏚️", "🏠", "🏡", "🏢", "🏣", "🏤", "🏥", "🏦", "🏨", "🏩", "🏪", "🏫",
    "🏬", "🏭", "🏯", "🏰", "💒", "🗼", "🗽", "⛪", "🕌", "🛕", "🕍", "⛩️", "🕋", "⛲", "⛺", "🌁", "🌃", "🏙️", "🌄", "🌅", "🌆",
    "🌇", "🌉", "♨️", "🎠", "🎡", "🎢", "💈", "🎪", "🚂", "🚃", "🚄", "🚅", "🚆", "🚇", "🚈", "🚉", "🚊", "🚝", "🚞", "🚋", "🚌",
    "🚍", "🚎", "🚐", "🚑", "🚒", "🚓", "🚔", "🚕", "🚖", "🚗", "🚘", "🚙", "🛻", "🚚", "🚛", "🚜", "🏎️", "🏍️", "🛵", "🦽", "🦼",
    "🛺", "🚲", "🛴", "🛹", "🛼", "🚏", "🛣️", "🛤️", "🛢️", "⛽", "🚨", "🚥", "🚦", "🛑", "🚧", "⚓", "⛵", "🛶", "🚤", "🛳️", "⛴️",
    "🛥️", "🚢", "✈️", "🛩️", "🛫", "🛬", "🪂", "💺", "🚁", "🚟", "🚠", "🚡", "🛰️", "🚀", "🛸", "🛎️", "🧳", "⌛", "⏳", "⌚", "⏰",
    "⏱️", "⏲️", "🕰️", "🕛", "🕧", "🕐", "🕜", "🕑", "🕝", "🕒", "🕞", "🕓", "🕟", "🕔", "🕠", "🕕", "🕡", "🕖", "🕢", "🕗", "🕣",
    "🕘", "🕤", "🕙", "🕥", "🕚", "🕦", "🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘", "🌙", "🌚", "🌛", "🌜", "🌡️", "☀️", "🌝",
    "🌞", "🪐", "⭐", "🌟", "🌠", "🌌", "☁️", "⛅", "⛈️", "🌤️", "🌥️", "🌦️", "🌧️", "🌨️", "🌩️", "🌪️", "🌫️", "🌬️", "🌀", "🌈", "🌂",
    "☂️", "☔", "⛱️", "⚡", "❄️", "☃️", "⛄", "☄️", "🔥", "💧", "🌊", "🎃", "🎄", "🎆", "🎇", "🧨", "✨", "🎈", "🎉", "🎊", "🎋",
    "🎍", "🎎", "🎏", "🎐", "🎑", "🧧", "🎀", "🎁", "🎗️", "🎟️", "🎫", "🎖️", "🏆", "🏅", "🥇", "🥈", "🥉", "⚽", "⚾", "🥎", "🏀",
    "🏐", "🏈", "🏉", "🎾", "🥏", "🎳", "🏏", "🏑", "🏒", "🥍", "🏓", "🏸", "🥊", "🥋", "🥅", "⛳", "⛸️", "🎣", "🤿", "🎽", "🎿",
    "🛷", "🥌", "🎯", "🪀", "🪁", "🎱", "🔮", "🪄", "🧿", "🎮", "🕹️", "🎰", "🎲", "🧩", "🧸", "🪅", "🪆", "♠️", "♥️", "♦️", "♣️",
    "♟️", "🃏", "🀄", "🎴", "🎭", "🖼️", "🎨", "🧵", "🪡", "🧶", "🪢", "👓", "🕶️", "🥽", "🥼", "🦺", "👔", "👕", "👖", "🧣", "🧤",
    "🧥", "🧦", "👗", "👘", "🥻", "🩱", "🩲", "🩳", "👙", "👚", "👛", "👜", "👝", "🛍️", "🎒", "🩴", "👞", "👟", "🥾", "🥿", "👠",
    "👡", "🩰", "👢", "👑", "👒", "🎩", "🎓", "🧢", "🪖", "⛑️", "📿", "💄", "💍", "💎", "🔇", "🔈", "🔉", "🔊", "📢", "📣", "📯",
    "🔔", "🔕", "🎼", "🎵", "🎶", "🎙️", "🎚️", "🎛️", "🎤", "🎧", "📻", "🎷", "🪗", "🎸", "🎹", "🎺", "🎻", "🪕", "🥁", "🪘", "📱",
    "📲", "☎️", "📞", "📟", "📠", "🔋", "🔌", "💻", "🖥️", "🖨️", "⌨️", "🖱️", "🖲️", "💽", "💾", "💿", "📀", "🧮", "🎥", "🎞️", "📽️",
    "🎬", "📺", "📷", "📸", "📹", "📼", "🔍", "🔎", "🕯️", "💡", "🔦", "🏮", "🪔", "📔", "📕", "📖", "📗", "📘", "📙", "📚", "📓",
    "📒", "📃", "📜", "📄", "📰", "🗞️", "📑", "🔖", "🏷️", "💰", "🪙", "💴", "💵", "💶", "💷", "💸", "💳", "🧾", "💹", "✉️", "📧",
    "📨", "📩", "📤", "📥", "📦", "📫", "📪", "📬", "📭", "📮", "🗳️", "✏️", "✒️", "🖋️", "🖊️", "🖌️", "🖍️", "📝", "💼", "📁", "📂",
    "🗂️", "📅", "📆", "🗒️", "🗓️", "📇", "📈", "📉", "📊", "📋", "📌", "📍", "📎", "🖇️", "📏", "📐", "✂️", "🗃️", "🗄️", "🗑️", "🔒",
    "🔓", "🔏", "🔐", "🔑", "🗝️", "🔨", "🪓", "⛏️", "⚒️", "🛠️", "🗡️", "⚔️", "🔫", "🪃", "🏹", "🛡️", "🪚", "🔧", "🪛", "🔩", "⚙️",
    "🗜️", "⚖️", "🦯", "🔗", "⛓️", "🪝", "🧰", "🧲", "🪜", "⚗️", "🧪", "🧫", "🧬", "🔬", "🔭", "📡", "💉", "🩸", "💊", "🩹", "🩺",
    "🚪", "🛗", "🪞", "🪟", "🛏️", "🛋️", "🪑", "🚽", "🪠", "🚿", "🛁", "🪤", "🪒", "🧴", "🧷", "🧹", "🧺", "🧻", "🪣", "🧼", "🫧",
    "🪥", "🧽", "🧯", "🛒", "🚬", "⚰️", "🪦", "⚱️", "🗿", "🪧", "🏧", "🚮", "🚰", "♿", "🚹", "🚺", "🚻", "🚼", "🚾", "🛂", "🛃",
    "🛄", "🛅", "⚠️", "🚸", "⛔", "🚫", "🚳", "🚭", "🚯", "🚱", "🚷", "📵", "🔞", "☢️", "☣️", "⬆️", "↗️", "➡️", "↘️", "⬇️", "↙️",
    "⬅️", "↖️", "↕️", "↔️", "↩️", "↪️", "⤴️", "⤵️", "🔃", "🔄", "🔙", "🔚", "🔛", "🔜", "🔝", "🛐", "⚛️", "🕉️", "✡️", "☸️", "☯️",
    "✝️", "☦️", "☪️", "☮️", "🕎", "🔯", "♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓", "⛎", "🔀", "🔁",
    "🔂", "▶️", "⏩", "⏭️", "⏯️", "◀️", "⏪", "⏮️", "🔼", "⏫", "🔽", "⏬", "⏸️", "⏹️", "⏺️", "⏏️", "🎦", "🔅", "🔆", "📶", "📳",
    "📴", "♀️", "♂️", "⚧", "✖️", "➕", "➖", "➗", "♾️", "‼️", "⁉️", "❓", "❔", "❕", "❗", "〰️", "💱", "💲", "⚕️", "♻️", "⚜️",
    "🔱", "📛", "🔰", "⭕", "✅", "☑️", "✔️", "❌", "❎", "➰", "➿", "〽️", "✳️", "✴️", "❇️", "©️", "®️", "™️", "#️⃣", "*️⃣", "0️⃣",
    "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "🔠", "🔡", "🔢", "🔣", "🔤", "🅰️", "🆎", "🅱️", "🆑", "🆒",
    "🆓", "ℹ️", "🆔", "Ⓜ️", "🆕", "🆖", "🅾️", "🆗", "🅿️", "🆘", "🆙", "🆚", "🈁", "🈂️", "🈷️", "🈶", "🈯", "🉐", "🈹", "🈚", "🈲",
    "🉑", "🈸", "🈴", "🈳", "㊗️", "㊙️", "🈺", "🈵", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩",
    "🟦", "🟪", "🟫", "⬛", "⬜", "◼️", "◻️", "◾", "◽", "▪️", "▫️", "🔶", "🔷", "🔸", "🔹", "🔺", "🔻", "💠", "🔘", "🔳", "🔲"
  ];
  let code = "";
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  code += emojis[Math.floor(Math.random() * emojis.length)];
  return code;
}

// --- In-Memory Cache for Speed ---
let dbCache = null;
let dbCacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds TTL for external changes, otherwise we use local cache

// Background save queue to prevent race conditions and allow instant response
let saveQueue = Promise.resolve();
function queueSaveDB(db) {
  // Update cache immediately
  dbCache = db;
  dbCacheTime = Date.now();
  
  // Queue the GitHub write
  saveQueue = saveQueue.then(() => saveDBInternal(db)).catch(err => console.error("Background save failed:", err));
}

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing GitHub env vars. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.");
}

app.use(express.json({ limit: "100mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "talky-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

// Helper to parse cookies manually since we don't have cookie-parser
function parseCookies(request) {
  const list = {};
  const rc = request.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function generateId(prefix) {
  const rnd = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${rnd}`;
}

function hashPassword(password, salt) {
  return crypto.createHmac("sha256", salt).update(password).digest("hex");
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return `${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split("$");
  const computed = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
}

async function githubRequest(path, options = {}) {
  const url = `https://api.github.com${path}`;

  // Merge default headers with any provided in options
  const defaultHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const providedHeaders = options.headers || {};
  const headers = { ...defaultHeaders, ...providedHeaders };

  // If a body is present and Content-Type wasn't explicitly provided, assume JSON
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    ...options,
    headers
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function loadDB() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return { users: [], chats: [], messages: [], requests: [], globalPaused: { messages: false } };
  }

  // Serve from cache if available and fresh enough (or if we just wrote to it)
  if (dbCache && (Date.now() - dbCacheTime < CACHE_TTL)) {
    // Return a deep copy to prevent mutation issues
    return JSON.parse(JSON.stringify(dbCache));
  }

  try {
    const file = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
        DATA_PATH
      )}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    const content = Buffer.from(file.content, "base64").toString("utf8");
    
    let json;
    if (!content || !content.trim()) {
      // Handle empty file gracefully
      json = { users: [], chats: [], messages: [], requests: [], globalPaused: { messages: false } };
    } else {
      json = JSON.parse(content);
    }

    json._sha = file.sha;
    if (!Array.isArray(json.users)) json.users = [];
    if (!Array.isArray(json.chats)) json.chats = [];
    if (!Array.isArray(json.messages)) json.messages = [];
    if (!Array.isArray(json.requests)) json.requests = []; // Ensure requests array exists
    if (!json.globalPaused || typeof json.globalPaused !== "object")
      json.globalPaused = { messages: false, login: false, signup: false };
    if (!json.globalLogoutAt) json.globalLogoutAt = 0;

    // Update cache
    dbCache = json;
    dbCacheTime = Date.now();

    return json;
  } catch (err) {
    if (String(err.message).includes("404")) {
      return { users: [], chats: [], messages: [], requests: [], globalPaused: { messages: false } };
    }
    console.error("Failed to load DB from GitHub:", err);
    // Return cache if available even if expired, better than crashing
    if (dbCache) return JSON.parse(JSON.stringify(dbCache));
    return { users: [], chats: [], messages: [], requests: [], globalPaused: { messages: false } };
  }
}

async function saveDBInternal(db) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return false;
  const sha = db._sha;
  const payload = { ...db };
  delete payload._sha;

  const content = Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString(
    "base64"
  );

  const body = {
    message: "Update Talky data.json",
    content,
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  try {
    const res = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
        DATA_PATH
      )}`,
      {
        method: "PUT",
        body: JSON.stringify(body)
      }
    );

    if (res && res.content && res.content.sha) {
      db._sha = res.content.sha;
      if (dbCache) dbCache._sha = res.content.sha;
    }
    return true;
  } catch (err) {
    console.error("Failed to save DB to GitHub:", err);
    return false;
  }
}

async function saveDB(db) {
  queueSaveDB(db);
  return true;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  
  // Check for forced logout
  const db = await loadDB();
  if (db.globalLogoutAt && req.session.loginTime && req.session.loginTime < db.globalLogoutAt) {
     req.session.destroy();
     return res.status(401).json({ error: "Session expired (Global Logout)" });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

// NEW: Admin Login (Fixes 404)
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  // Simple timing-safe comparison not strictly necessary for this simple env variable check, 
  // but good practice. Here we just check equality.
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    console.log(`[Admin] Login successful from ${req.ip}`);
    // If user is logged in, update their user object in session too if needed, 
    // but req.session.isAdmin is the gatekeeper.
    res.json({ ok: true });
  } else {
    console.warn(`[Admin] Failed login attempt from ${req.ip}`);
    res.status(401).json({ error: "Invalid admin password" });
  }
});

// NEW: Presence Heartbeat
app.post("/api/presence", requireAuth, (req, res) => {
  const { status } = req.body; // 'online' or 'away'
  const ip = req.ip || req.connection.remoteAddress;
  userPresence[req.session.userId] = { status, lastSeen: Date.now(), ip };
  res.json({ ok: true });
});

// NEW: Get All Presence
app.get("/api/presence", requireAuth, (req, res) => {
  res.json({ presence: userPresence });
});

// NEW: Get Local Network Users (Same IP Only)
app.get("/api/users", requireAuth, async (req, res) => {
  const db = await loadDB();
  const currentIp = req.ip || req.connection.remoteAddress;
  
  // Find online users with the same IP
  const onlineLocalIds = Object.keys(userPresence).filter(uid => {
    const p = userPresence[uid];
    // Check if IP matches and it's not the current user
    return p && p.ip === currentIp && uid !== req.session.userId;
  });

  // Return minimal info for these users
  const users = db.users
    .filter(u => onlineLocalIds.includes(u.id))
    .map(u => ({ id: u.id, username: u.username }));
    
  res.json({ users });
});

// NEW: Chat Requests System
app.get("/api/requests", requireAuth, async (req, res) => {
  const db = await loadDB();
  const myRequests = (db.requests || []).filter(r => r.toUserId === req.session.userId);
  const enriched = myRequests.map(r => {
    const sender = db.users.find(u => u.id === r.fromUserId);
    return { ...r, senderName: sender ? sender.username : "Unknown" };
  });
  res.json({ requests: enriched });
});

app.post("/api/requests", requireAuth, async (req, res) => {
  const { toUserId } = req.body;
  const db = await loadDB();
  if (!db.requests) db.requests = [];
  
  // Check if chat already exists
  const existingChat = db.chats.find(c => 
    c.type === 'dm' && 
    c.participantIds.includes(req.session.userId) && 
    c.participantIds.includes(toUserId)
  );
  if (existingChat) return res.status(400).json({ error: "Chat already exists" });

  // Check if request already exists
  const existingReq = db.requests.find(r => r.fromUserId === req.session.userId && r.toUserId === toUserId);
  if (existingReq) return res.status(400).json({ error: "Request already sent" });

  const reqObj = {
    id: generateId("req"),
    fromUserId: req.session.userId,
    toUserId,
    createdAt: new Date().toISOString()
  };
  db.requests.push(reqObj);
  await saveDB(db);
  res.json({ ok: true });
});

app.post("/api/requests/:id/accept", requireAuth, async (req, res) => {
  const reqId = req.params.id;
  const db = await loadDB();
  if (!db.requests) db.requests = [];
  const reqIndex = db.requests.findIndex(r => r.id === reqId);
  if (reqIndex === -1) return res.status(404).json({ error: "Request not found" });
  
  const request = db.requests[reqIndex];
  if (request.toUserId !== req.session.userId) return res.status(403).json({ error: "Not authorized" });

  // Create Chat
  const chat = {
    id: generateId("c"),
    name: "Direct Message", 
    type: "dm",
    participantIds: [request.fromUserId, request.toUserId],
    encryption: { version: 1, keyHash: "manual-setup-required" },
    createdAt: new Date().toISOString()
  };
  
  db.chats.push(chat);
  db.requests.splice(reqIndex, 1); // Remove request
  await saveDB(db);
  res.json({ chat });
});

app.post("/api/requests/:id/decline", requireAuth, async (req, res) => {
  const reqId = req.params.id;
  const db = await loadDB();
  if (!db.requests) db.requests = [];
  const reqIndex = db.requests.findIndex(r => r.id === reqId);
  
  if (reqIndex !== -1) {
    const request = db.requests[reqIndex];
    if (request.toUserId === req.session.userId || request.fromUserId === req.session.userId) {
      db.requests.splice(reqIndex, 1);
      await saveDB(db);
    }
  }
  res.json({ ok: true });
});

// NEW: Get Signup Code (Admin Only)
app.get("/api/admin/code", requireAdmin, (req, res) => {
  res.json({ code: currentSignupCode });
});

app.get("/api/me", async (req, res) => {
  const db = await loadDB();
  const userId = req.session.userId;
  if (!userId) return res.json({ user: null });
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.json({ user: null });
  res.json({
    user: {
      id: user.id,
      username: user.username,
      isAdmin: !!user.isAdmin
    }
  });
});

// NEW: Change Username
app.post("/api/me/username", requireAuth, async (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || newUsername.length < 3) return res.status(400).json({ error: "Invalid username" });
  
  const db = await loadDB();
  const existing = db.users.find(u => u.username.toLowerCase() === newUsername.toLowerCase());
  if (existing) return res.status(409).json({ error: "Username taken" });

  const user = db.users.find(u => u.id === req.session.userId);
  if (user) {
    user.username = newUsername;
    await saveDB(db);
    res.json({ user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// NEW: Change Password
app.post("/api/me/password", requireAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password too short" });

  const db = await loadDB();
  const user = db.users.find(u => u.id === req.session.userId);
  if (user) {
    user.passwordHash = createPasswordHash(newPassword);
    await saveDB(db);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  const { username, password, code } = req.body || {};
  
  // Check Cookie Block
  const cookies = parseCookies(req);
  const blockTime = cookies['talky_signup_block'];
  if (blockTime && parseInt(blockTime) > Date.now()) {
    const remaining = Math.ceil((parseInt(blockTime) - Date.now()) / 60000);
    return res.status(403).json({ error: `Too many failed attempts. Try again in ${remaining} minutes.` });
  }

  // Validate Code
  if (!code || code !== currentSignupCode) {
    // Block for 2 hours 30 minutes (150 minutes)
    const expiry = Date.now() + (150 * 60 * 1000);
    res.cookie('talky_signup_block', expiry.toString(), { maxAge: 150 * 60 * 1000, httpOnly: true });
    return res.status(403).json({ error: "Invalid invite code. You are blocked for 2.5 hours." });
  }

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const db = await loadDB();

  if (db.globalPaused && db.globalPaused.signup) {
    return res.status(503).json({ error: "Signups are currently disabled." });
  }

  const existing = db.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (existing) {
    return res.status(409).json({ error: "Username already taken." });
  }

  const id = generateId("u");
  const passwordHash = createPasswordHash(password);
  const isAdmin = db.users.length === 0;

  const user = {
    id,
    username,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);

  await saveDB(db);

  req.session.userId = user.id;
  req.session.isAdmin = user.isAdmin;
  req.session.loginTime = Date.now();

  res.status(201).json({
    user: {
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin
    }
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  const db = await loadDB();

  if (db.globalPaused && db.globalPaused.login && !user.isAdmin) { // Admins can still login
     return res.status(503).json({ error: "Login is currently disabled." });
  }

  const user = db.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  req.session.userId = user.id;
  req.session.isAdmin = !!user.isAdmin;
  req.session.loginTime = Date.now();

  res.json({
    user: {
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin
    }
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/chats", requireAuth, async (req, res) => {
  const db = await loadDB();
  const userId = req.session.userId;
  const chats = db.chats.filter((c) => (c.participantIds || []).includes(userId));
  
  // Enrich chats with participant info for client-side mention resolution
  const enrichedChats = chats.map(c => {
    const participants = db.users
      .filter(u => (c.participantIds || []).includes(u.id))
      .map(u => ({ id: u.id, username: u.username }));
    return { ...c, participants };
  });

  const messagesByChat = {};
  for (const chat of chats) {
    messagesByChat[chat.id] = db.messages
      .filter((m) => m.chatId === chat.id)
      .sort((a, b) => a.ts - b.ts);
  }
  res.json({ chats: enrichedChats, messagesByChat });
});

app.post("/api/chats", requireAuth, async (req, res) => {
  const { name, participants, encryptionKeyHash } = req.body || {};
  if (!name) return res.status(400).json({ error: "Chat name required." });
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: "At least one other participant is required." });
  }
  if (!encryptionKeyHash || typeof encryptionKeyHash !== "string") {
    return res.status(400).json({ error: "Missing encryption key hash." });
  }

  const db = await loadDB();
  const allUsers = db.users;
  const participantIds = [];

  const currentUserId = req.session.userId;
  participantIds.push(currentUserId);

  const missing = [];
  for (const p of participants) {
    if (typeof p !== "string") {
      missing.push(String(p));
      continue;
    }

    let u = null;
    if (p.startsWith("u_")) {
      u = allUsers.find((user) => user.id === p);
      if (!u) missing.push(p);
    } else {
      u = allUsers.find(
        (user) => user.username.toLowerCase() === p.toLowerCase()
      );
      if (!u) missing.push(p);
    }

    if (u && !participantIds.includes(u.id)) {
      participantIds.push(u.id);
    }
  }

  if (missing.length) {
    return res
      .status(400)
      .json({ error: `User(s) not found: ${missing.join(", ")}` });
  }

  const type = participantIds.length > 2 ? "group" : "dm";

  const chat = {
    id: generateId("c"),
    name,
    type,
    participantIds,
    encryption: {
      version: 1,
      keyHash: encryptionKeyHash
    },
    createdAt: new Date().toISOString()
  };

  db.chats.push(chat);
  await saveDB(db);

  res.status(201).json({ chat });
});

// NEW: Upload File to GitHub (separate from data.json)
app.post("/api/upload", requireAuth, async (req, res) => {
  const { content, ext } = req.body; // content is base64 encrypted data
  if (!content || !ext) return res.status(400).json({ error: "Missing content or extension" });

  // Security: Sanitize extension to prevent path traversal
  const safeExt = path.extname(ext).replace(/[^a-z0-9.]/gi, "");
  if (!safeExt) return res.status(400).json({ error: "Invalid extension" });

  // Security: Limit size (approx 50MB in base64 is ~37MB binary)
  if (content.length > 70 * 1024 * 1024) { 
    return res.status(413).json({ error: "File too large" });
  }

  const userId = req.session.userId;
  const randomName = crypto.randomBytes(16).toString("hex");
  const fileName = `${randomName}${safeExt}`;
  const filePath = `talky/uploads/${userId}/${fileName}`;

  const body = {
    message: `Upload ${fileName}`,
    content: content, // GitHub API expects base64 content
    branch: GITHUB_BRANCH
  };

  try {
    await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`,
      { method: "PUT", body: JSON.stringify(body) }
    );
    res.json({ path: filePath });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// NEW: Get File from GitHub
app.get("/api/file", requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send("Missing path");

  // Security: Prevent path traversal and restrict to uploads directory
  if (filePath.includes("..") || !filePath.startsWith("talky/uploads/")) {
    return res.status(403).send("Access denied");
  }

  try {
    const file = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    
    let buffer;
    if (file.content) {
      // Small file (<1MB), content is in response (base64 encoded by GitHub API)
      buffer = Buffer.from(file.content, "base64");
    } else if (file.download_url) {
      // Large file, fetch from download_url
      const downloadRes = await fetch(file.download_url, {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
      });
      if (!downloadRes.ok) throw new Error("Failed to download raw file");
      const arrayBuffer = await downloadRes.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      throw new Error("No content found");
    }

    res.set("Content-Type", "application/octet-stream");
    res.send(buffer);
  } catch (err) {
    console.error("File fetch failed:", err);
    res.status(404).send("File not found");
  }
});

// Messages endpoint: check global pause
app.post("/api/messages", requireAuth, async (req, res) => {
  const { chatId, ciphertext, iv, mentions } = req.body || {};
  if (!chatId || !ciphertext || !iv) {
    return res.status(400).json({ error: "chatId, ciphertext, and iv are required." });
  }

  const db = await loadDB();

  if (db.globalPaused && db.globalPaused.messages && !req.session.isAdmin) {
    return res.status(503).json({ error: "Messaging is currently disabled by admin." });
  }

  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;

  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }

  const msg = {
    id: generateId("m"),
    chatId,
    fromUserId: userId,
    ciphertext,
    iv,
    mentions: Array.isArray(mentions) ? mentions : [],
    ts: Date.now()
  };
  db.messages.push(msg);
  
  // Use non-blocking save for instant response
  queueSaveDB(db);

  res.status(201).json({ message: msg });
});

// Chat management endpoints: rename, clear messages, delete, set-key in-place, rotate(create new & delete old)
app.post("/api/chats/:id/rename", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "New name required." });
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }
  chat.name = String(name).slice(0, 200);
  await saveDB(db);
  res.json({ chat });
});

app.post("/api/chats/:id/clear", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }
  db.messages = db.messages.filter((m) => m.chatId !== chatId);
  await saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/chats/:id", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const db = await loadDB();
  const chatIndex = db.chats.findIndex((c) => c.id === chatId);
  const userId = req.session.userId;
  if (chatIndex === -1) return res.status(404).json({ error: "Chat not found." });
  const chat = db.chats[chatIndex];
  if (!(chat.participantIds || []).includes(userId)) {
    return res.status(403).json({ error: "Not a participant." });
  }
  db.chats.splice(chatIndex, 1);
  db.messages = db.messages.filter((m) => m.chatId !== chatId);
  await saveDB(db);
  res.json({ ok: true });
});

// Set key in-place (update encryption.keyHash) - client will still keep raw code locally
app.post("/api/chats/:id/set-key", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const { encryptionKeyHash } = req.body || {};
  if (!encryptionKeyHash) return res.status(400).json({ error: "encryptionKeyHash required." });
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }
  chat.encryption = chat.encryption || {};
  chat.encryption.version = (chat.encryption && chat.encryption.version) || 1;
  chat.encryption.keyHash = encryptionKeyHash;
  chat.updatedAt = new Date().toISOString();
  await saveDB(db);
  res.json({ chat });
});

// Rotate key: create a new chat with same participants & name (new id), delete old chat + messages.
// returns the new chat object. Clients should share the new code out-of-band.
app.post("/api/chats/:id/rotate", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const { encryptionKeyHash } = req.body || {};
  if (!encryptionKeyHash) return res.status(400).json({ error: "encryptionKeyHash required." });

  const db = await loadDB();
  const oldIndex = db.chats.findIndex((c) => c.id === chatId);
  const userId = req.session.userId;
  if (oldIndex === -1) return res.status(404).json({ error: "Chat not found." });
  const oldChat = db.chats[oldIndex];
  if (!(oldChat.participantIds || []).includes(userId)) {
    return res.status(403).json({ error: "Not a participant." });
  }

  const newChat = {
    id: generateId("c"),
    name: oldChat.name + " (rotated)",
    type: oldChat.type,
    participantIds: [...oldChat.participantIds],
    encryption: {
      version: (oldChat.encryption && oldChat.encryption.version) || 1,
      keyHash: encryptionKeyHash
    },
    createdAt: new Date().toISOString()
  };

  // remove old chat and its messages
  db.chats.splice(oldIndex, 1);
  db.chats.push(newChat);
  db.messages = db.messages.filter((m) => m.chatId !== chatId);

  await saveDB(db);
  res.json({ chat: newChat });
});

// NEW: Admin System Management
app.get("/api/admin/system", requireAdmin, async (req, res) => {
  const db = await loadDB();
  res.json({ 
    globalPaused: db.globalPaused || {},
    globalLogoutAt: db.globalLogoutAt || 0
  });
});

app.post("/api/admin/system/maintenance", requireAdmin, async (req, res) => {
  const { login, signup, messages } = req.body;
  const db = await loadDB();
  db.globalPaused = { ...db.globalPaused, ...req.body };
  await saveDB(db);
  res.json({ globalPaused: db.globalPaused });
});

app.post("/api/admin/system/logout-all", requireAdmin, async (req, res) => {
  const db = await loadDB();
  db.globalLogoutAt = Date.now();
  await saveDB(db);
  res.json({ ok: true, globalLogoutAt: db.globalLogoutAt });
});

// NEW: Admin User Management
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const db = await loadDB();
  const users = db.users.map(u => ({ 
    id: u.id, 
    username: u.username, 
    isAdmin: u.isAdmin, 
    createdAt: u.createdAt 
  }));
  res.json({ users });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  const { username, password, isAdmin } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing fields" });
  
  const db = await loadDB();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "Username taken" });
  }
  
  const newUser = {
    id: generateId("u"),
    username,
    passwordHash: createPasswordHash(password),
    isAdmin: !!isAdmin,
    createdAt: new Date().toISOString()
  };
  db.users.push(newUser);
  await saveDB(db);
  res.json({ user: { id: newUser.id, username: newUser.username } });
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const db = await loadDB();
  const idx = db.users.findIndex(u => u.id === id);
  if (idx === -1) return res.status(404).json({ error: "User not found" });
  
  // Prevent deleting self
  if (id === req.session.userId) return res.status(400).json({ error: "Cannot delete yourself" });
  
  db.users.splice(idx, 1);
  await saveDB(db);
  res.json({ ok: true });
});

// NEW: Admin Chat Management
app.get("/api/admin/chats", requireAdmin, async (req, res) => {
  const db = await loadDB();
  const chats = db.chats.map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    participants: c.participantIds.length,
    msgCount: db.messages.filter(m => m.chatId === c.id).length
  }));
  res.json({ chats });
});

app.delete("/api/admin/chats/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const db = await loadDB();
  const idx = db.chats.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Chat not found" });
  
  db.chats.splice(idx, 1);
  db.messages = db.messages.filter(m => m.chatId !== id);
  await saveDB(db);
  res.json({ ok: true });
});

// NEW: Get participants of a chat
app.get("/api/chats/:id/participants", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }

  const participants = db.users
    .filter(u => chat.participantIds.includes(u.id))
    .map(u => ({ id: u.id, username: u.username }));

  res.json({ participants });
});

// Admin: pause/unpause messaging
app.post("/api/admin/pause", requireAdmin, async (req, res) => {
  const { pauseMessages } = req.body || {};
  const db = await loadDB();
  db.globalPaused = db.globalPaused || { messages: false };
  if (typeof pauseMessages === "boolean") db.globalPaused.messages = pauseMessages;
  await saveDB(db);
  res.json({ globalPaused: db.globalPaused });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Talky (GitHub-backed, encrypted) running on http://localhost:${PORT}`);
});
