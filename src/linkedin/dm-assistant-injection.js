const ORTUS_DM_CONTENT_VERSION = "1.2";
const ORTUS_DM_MESSAGE_SOURCE = `ortus-dm:${ORTUS_DM_CONTENT_VERSION}`;
window.__ORTUS_DM_ASSISTANT_LOADED__ = true;
window.__ORTUS_DM_ASSISTANT_VERSION__ = ORTUS_DM_CONTENT_VERSION;

const DEFAULT_DM_TEMPLATE = "Hi {first name}, thanks for connecting. I wanted to send this across while it is fresh.";
const DEFAULT_INTRO_NAME = "Antonio";
const DEFAULT_INTRO_SUBJECT_TEMPLATE = "Introduction: {first name} <> {intro name}";
const DEFAULT_INTRO_BODY_TEMPLATE = "Hi {first name}, introducing you to {intro name}.\n\n{intro name}, meet {first name}, {title} at {company}.\n\nI thought it made sense for you both to connect.";

const DM_TEMPLATE_STORAGE_KEY = "dmTemplate";
const INTRO_NAME_STORAGE_KEY = "introName";
const INTRO_SUBJECT_TEMPLATE_STORAGE_KEY = "introSubjectTemplate";
const INTRO_BODY_TEMPLATE_STORAGE_KEY = "introBodyTemplate";
const EXTENSION_ENABLED_STORAGE_KEY = "dmExtensionEnabled";
const BROWSER_MODE_STORAGE_KEY = "dmBrowserMode";
const CONTACTS_STORAGE_KEY = "dmSheetContacts";
const BROWSER_MODE_NORMAL = "normal";
const BROWSER_MODE_VM = "vm";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isActionCandidate(element) {
    if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}

function isVisibleElement(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}

function activateElement(element) {
    if (isUnsafeRightPanelTarget(element)) {
        console.log("Ortus DM Assistant: blocked right-panel target", element);
        return false;
    }

    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.focus?.();
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
    return true;
}

function normalizeButtonText(value) {
    return (value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function isExactishButtonText(value, target) {
    return value === target || value.startsWith(`${target} `) || value.endsWith(` ${target}`);
}

function getElementTextValues(element) {
    const root = element.getRootNode?.() || document;
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => root.getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || "")
        .join(" ");

    return [
        element.innerText,
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        labelledBy
    ].map(normalizeButtonText).filter(Boolean);
}

function doesButtonMatch(element, normalizedTargets, options = {}) {
    const values = getElementTextValues(element);
    return normalizedTargets.some((target) => values.some((value) => (
        options.exact ? isExactishButtonText(value, target) : value === target || value.includes(target)
    )));
}

function querySelectorDeep(root, selector) {
    return querySelectorAllDeep(root, selector)[0] || null;
}

function querySelectorAllDeep(root, selector) {
    if (!root?.querySelectorAll) return [];

    const results = [];
    const seen = new Set();
    const visitRoot = (currentRoot) => {
        if (!currentRoot?.querySelectorAll) return;

        currentRoot.querySelectorAll(selector).forEach((element) => {
            if (seen.has(element)) return;
            seen.add(element);
            results.push(element);
        });

        currentRoot.querySelectorAll("*").forEach((element) => {
            if (element.shadowRoot) visitRoot(element.shadowRoot);
        });
    };

    visitRoot(root);
    return results;
}

function findButtonInRoot(root, possibleTexts, options = {}) {
    if (!root) return null;

    const normalizedTargets = possibleTexts.map((text) => text.toLowerCase());
    const candidates = querySelectorAllDeep(root, 'button, [role="button"], a[role="button"]')
        .filter((element) => isActionCandidate(element) && !isUnsafeRightPanelTarget(element));

    for (const element of candidates) {
        if (!doesButtonMatch(element, normalizedTargets, options)) continue;
        return element;
    }

    return null;
}

function findTextActionInRoot(root, possibleTexts, options = {}) {
    if (!root) return null;

    const normalizedTargets = possibleTexts.map((text) => text.toLowerCase());
    return querySelectorAllDeep(root, "button, [role='button'], a[role='button'], button *, [role='button'] *, a[role='button'] *")
        .filter(isVisibleElement)
        .filter((element) => {
            const values = getElementTextValues(element);
            return normalizedTargets.some((target) => values.some((value) => (
                options.exact ? isExactishButtonText(value, target) : value === target || value.includes(target)
            )));
        })
        .map((element) => element.closest('button, [role="button"], a[role="button"]') || element)
        .filter((element, index, elements) => elements.indexOf(element) === index)
        .find((element) => isActionCandidate(element) && !isUnsafeRightPanelTarget(element)) || null;
}

function clickButtonInRoot(root, possibleTexts, options = {}) {
    const element = findTextActionInRoot(root, possibleTexts, options) || findButtonInRoot(root, possibleTexts, options);
    return element ? activateElement(element) : false;
}

function clickLinkedInButton(possibleTexts, options = {}) {
    const dialogs = querySelectorAllDeep(document, '[role="dialog"], .artdeco-modal');
    const menu = querySelectorDeep(document, '[role="menu"], .artdeco-dropdown__content--is-open');
    const profileMain = document.querySelector("main");
    const roots = dialogs.length ? dialogs : [menu, profileMain, document].filter(Boolean);

    for (const root of roots) {
        if (clickButtonInRoot(root, possibleTexts, options)) return true;
    }

    return false;
}

function getProfileTopCardRoot() {
    const main = document.querySelector("main");
    const heading = main?.querySelector("h1") || document.querySelector("main .text-heading-xlarge");
    if (heading) {
        const root = findProfileHeaderRoot(heading, main);
        if (root) return root;
    }

    for (const selector of ["main .pv-top-card", "main .pv-top-card-v2-ctas__custom", "main section.artdeco-card"]) {
        const root = document.querySelector(selector);
        if (root) return root;
    }

    return null;
}

function findProfileHeaderRoot(heading, main) {
    const headingRect = heading.getBoundingClientRect();
    const candidates = [];
    let node = heading;

    while (node && node !== document.body) {
        if (node.nodeType === Node.ELEMENT_NODE && (node === main || node.matches("section, article, div"))) {
            const rect = node.getBoundingClientRect();
            const hasNearbyAction = Array.from(node.querySelectorAll('button, [role="button"], a[role="button"]'))
                .some((button) => isProfileHeaderAction(button, headingRect));

            if (hasNearbyAction && rect.height > 0 && rect.height <= 760) {
                candidates.push({ node, area: rect.width * rect.height });
            }
        }

        if (node === main) break;
        node = node.parentElement;
    }

    candidates.sort((a, b) => a.area - b.area);
    return candidates[0]?.node || null;
}

function findProfileHeaderButton(possibleTexts, options = {}) {
    const root = getProfileTopCardRoot() || document.querySelector("main");
    const heading = root?.querySelector("h1") || document.querySelector("main h1, main .text-heading-xlarge");
    const headingRect = heading?.getBoundingClientRect();
    if (!root || !headingRect) return null;

    const normalizedTargets = possibleTexts.map((text) => text.toLowerCase());
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], a[role="button"]'))
        .filter((element) => isProfileHeaderAction(element, headingRect))
        .filter((element) => doesButtonMatch(element, normalizedTargets, options))
        .map((element) => ({ element, distance: getProfileHeaderDistance(element, headingRect) }))
        .sort((a, b) => a.distance - b.distance);

    return candidates[0]?.element || null;
}

function findVmProfileHeaderButton(possibleTexts, options = {}) {
    const main = document.querySelector("main");
    const heading = main?.querySelector("h1, .text-heading-xlarge");
    const headingRect = heading?.getBoundingClientRect();
    if (!main || !headingRect) return null;

    const normalizedTargets = possibleTexts.map((text) => text.toLowerCase());
    const candidates = Array.from(main.querySelectorAll('button, [role="button"], a[role="button"]'))
        .filter((element) => isActionCandidate(element) && !isUnsafeRightPanelTarget(element))
        .filter((element) => isBelowProfileHeading(element, headingRect))
        .filter((element) => doesButtonMatch(element, normalizedTargets, options))
        .map((element) => ({ element, distance: getProfileHeaderDistance(element, headingRect) }))
        .sort((a, b) => a.distance - b.distance);

    return candidates[0]?.element || null;
}

function isProfileHeaderAction(element, headingRect) {
    if (!isActionCandidate(element) || isUnsafeRightPanelTarget(element)) return false;

    const rect = element.getBoundingClientRect();
    const isNearProfileHeading = (
        rect.top >= headingRect.top - 80 &&
        rect.top <= headingRect.bottom + 520 &&
        rect.left < Math.max(window.innerWidth * 0.72, headingRect.left + 780)
    );
    const hasActionText = doesButtonMatch(element, ["message", "more", "more actions", "connect", "follow"], { exact: false });
    return isNearProfileHeading && hasActionText;
}

function isBelowProfileHeading(element, headingRect) {
    const rect = element.getBoundingClientRect();
    return (
        rect.top >= headingRect.bottom - 40 &&
        rect.top <= headingRect.bottom + 520 &&
        rect.left >= Math.max(0, headingRect.left - 80) &&
        rect.left < Math.max(window.innerWidth * 0.72, headingRect.left + 820)
    );
}

function getProfileHeaderDistance(element, headingRect) {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.top - headingRect.bottom) + Math.max(0, rect.left - headingRect.left);
}

function getOpenActionMenuRoot(anchorElement = null) {
    const menus = querySelectorAllDeep(document, '[role="menu"], .artdeco-dropdown__content--is-open')
        .filter(isVisibleElement);

    if (!anchorElement) return menus[0] || null;

    const anchorRect = anchorElement.getBoundingClientRect();
    const anchorCenterX = anchorRect.left + (anchorRect.width / 2);
    const anchorCenterY = anchorRect.top + (anchorRect.height / 2);

    return menus
        .map((menu) => {
            const rect = menu.getBoundingClientRect();
            return {
                menu,
                distance: Math.abs((rect.left + rect.width / 2) - anchorCenterX) + Math.abs((rect.top + rect.height / 2) - anchorCenterY)
            };
        })
        .filter((entry) => entry.distance <= 700)
        .sort((a, b) => a.distance - b.distance)[0]?.menu || null;
}

function clickOpenProfileMenuAction(anchorElement, possibleTexts, options = {}) {
    const menuRoot = getOpenActionMenuRoot(anchorElement);
    if (clickButtonInRoot(menuRoot, possibleTexts, options)) return true;
    return false;
}

function isSidebarElement(element) {
    return Boolean(element.closest('aside, [role="complementary"], .scaffold-layout__aside, .ad-banner-container'));
}

function isUnsafeRightPanelTarget(element) {
    if (!element) return true;
    if (isSidebarElement(element)) return true;

    const rect = element.getBoundingClientRect();
    const appearsInRightRail = rect.left >= Math.max(window.innerWidth * 0.58, 860);

    if (element.closest([
        ".scaffold-layout__aside",
        ".scaffold-layout__sidebar",
        ".pv-profile-sticky-header",
        ".ad-banner-container",
        '[aria-label*="People also viewed"]',
        '[aria-label*="People you may know"]',
        '[aria-label*="Similar profiles"]'
    ].join(","))) {
        return true;
    }

    if (!appearsInRightRail) return false;

    const card = element.closest("section, article, aside, [role='complementary']");
    const cardText = normalizeButtonText(card?.innerText || card?.textContent);
    return ["people also viewed", "people you may know", "similar profiles", "more profiles for you", "other profiles viewed"]
        .some((label) => cardText.includes(label));
}

function cleanProfileText(value) {
    return (value || "")
        .replace(/\(.*?\)/g, " ")
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
        .replace(/[^\p{L}\p{N}\s&.,/'-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractProfileFullName() {
    for (const source of getProfileNameSources()) {
        const value = cleanProfileText(source?.textContent);
        if (value) return value;
    }

    return "";
}

function getProfileNameSources() {
    const topCard = getProfileTopCardRoot();

    return [
        topCard?.querySelector("h1"),
        topCard?.querySelector(".text-heading-xlarge"),
        topCard?.querySelector(".pv-text-details__left-panel h1"),
        document.querySelector("main h1"),
        document.querySelector("main .text-heading-xlarge"),
        document.querySelector("main .pv-text-details__left-panel h1"),
        document.querySelector('main [data-anonymize="person-name"]')
    ].filter(Boolean);
}

function getTopCardSubline() {
    const selectors = [
        "main .text-body-medium.break-words",
        ".pv-text-details__left-panel .text-body-medium",
        "main .pv-text-details__left-panel div.text-body-medium",
        "main .text-body-medium"
    ];

    for (const selector of selectors) {
        const value = cleanProfileText(document.querySelector(selector)?.textContent);
        if (value) return value;
    }

    return "";
}

function splitTitleAndCompany(text) {
    if (!text) return { title: "", company: "" };

    const atMatch = text.match(/^(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
        return { title: atMatch[1].trim(), company: atMatch[2].trim() };
    }

    for (const separator of [" @ ", " | ", " - ", ", "]) {
        const index = text.indexOf(separator);
        if (index > 0) {
            return {
                title: text.slice(0, index).trim(),
                company: text.slice(index + separator.length).trim()
            };
        }
    }

    return { title: text.trim(), company: "" };
}

function extractProfileData() {
    const fullName = extractProfileFullName();
    const parts = fullName.split(/\s+/).filter(Boolean);
    const { title, company } = splitTitleAndCompany(getTopCardSubline());

    return {
        fullName,
        firstName: parts[0] || "",
        title,
        company
    };
}

async function getSavedText(key, fallback) {
    if (!chrome?.storage?.sync) return fallback;

    try {
        const result = await chrome.storage.sync.get({ [key]: fallback });
        return result[key] || fallback;
    } catch (error) {
        console.log("Ortus DM Assistant: storage read failed", error);
        return fallback;
    }
}

async function isExtensionEnabled() {
    if (!chrome?.storage?.sync) return true;

    try {
        const result = await chrome.storage.sync.get({ [EXTENSION_ENABLED_STORAGE_KEY]: true });
        return result[EXTENSION_ENABLED_STORAGE_KEY] !== false;
    } catch (error) {
        console.log("Ortus DM Assistant: enabled state read failed", error);
        return true;
    }
}

async function getBrowserMode() {
    if (!chrome?.storage?.sync) return BROWSER_MODE_NORMAL;

    try {
        const result = await chrome.storage.sync.get({ [BROWSER_MODE_STORAGE_KEY]: BROWSER_MODE_NORMAL });
        return result[BROWSER_MODE_STORAGE_KEY] === BROWSER_MODE_VM ? BROWSER_MODE_VM : BROWSER_MODE_NORMAL;
    } catch (error) {
        console.log("Ortus DM Assistant: browser mode read failed", error);
        return BROWSER_MODE_NORMAL;
    }
}

async function getSheetContacts() {
    if (!chrome?.storage?.local) return [];

    try {
        const result = await chrome.storage.local.get({ [CONTACTS_STORAGE_KEY]: [] });
        return Array.isArray(result[CONTACTS_STORAGE_KEY]) ? result[CONTACTS_STORAGE_KEY] : [];
    } catch (error) {
        console.log("Ortus DM Assistant: contacts read failed", error);
        return [];
    }
}

function normalizeForMatch(value) {
    return (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function normalizeLinkedInProfileUrl(value) {
    try {
        const url = new URL(value || window.location.href, window.location.origin);
        const match = url.pathname.match(/\/in\/([^/?#]+)/i);
        return match ? match[1].toLowerCase().replace(/\/$/, "") : "";
    } catch (_error) {
        const match = String(value || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
        return match ? match[1].toLowerCase().replace(/\/$/, "") : "";
    }
}

function matchContactFromSheet(contacts, profile) {
    const pageSlug = normalizeLinkedInProfileUrl(window.location.href);
    if (pageSlug) {
        const urlMatch = contacts.find((contact) => normalizeLinkedInProfileUrl(contact.linkedinUrl) === pageSlug);
        if (urlMatch) return urlMatch;
    }

    const fullName = (profile.fullName || "").split(/\s+/).filter(Boolean);
    const targetFirst = normalizeForMatch(profile.firstName || fullName[0]);
    const targetLast = normalizeForMatch(fullName.length > 1 ? fullName[fullName.length - 1] : "");
    const targetCompany = normalizeForMatch(profile.company);
    if (!targetFirst || !targetLast) return null;

    const nameMatches = contacts.filter((contact) => (
        normalizeForMatch(contact.firstName) === targetFirst &&
        normalizeForMatch(contact.lastName) === targetLast
    ));

    if (nameMatches.length === 0) return null;
    if (nameMatches.length === 1) return nameMatches[0];

    if (targetCompany) {
        const companyMatches = nameMatches.filter((contact) => {
            const contactCompany = normalizeForMatch(contact.company);
            return contactCompany === targetCompany || contactCompany.includes(targetCompany) || targetCompany.includes(contactCompany);
        });
        if (companyMatches.length === 1) return companyMatches[0];
    }

    return null;
}

async function personalizeTemplate(template, options = {}) {
    const profile = extractProfileData();
    const contacts = await getSheetContacts();
    const matched = matchContactFromSheet(contacts, profile);
    const introName = options.introName || await getSavedText(INTRO_NAME_STORAGE_KEY, DEFAULT_INTRO_NAME);
    const firstName = matched?.firstName || profile.firstName;
    const title = matched?.title || profile.title;
    const company = matched?.company || profile.company;

    return template
        .replace(/\{first[\s_-]*name\}/gi, firstName || "{first name}")
        .replace(/\{firstname\}/gi, firstName || "{firstname}")
        .replace(/\{title\}/gi, title || "{title}")
        .replace(/\{company\}/gi, company || "{company}")
        .replace(/\{intro[\s_-]*name\}/gi, introName || "{intro name}")
        .replace(/\{introname\}/gi, introName || "{introname}");
}

function isTypingTarget(target) {
    if (!target) return false;
    const tagName = (target.tagName || "").toUpperCase();
    return (
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        target.isContentEditable === true ||
        target.closest?.('[contenteditable="true"], [role="textbox"]')
    );
}

function getComposeRoots() {
    const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
    return dialog ? [dialog, document] : [document];
}

function getMessageInputTarget(options = {}) {
    const active = document.activeElement;
    if (!options.ignoreActive && isTypingTarget(active)) return active;

    for (const root of getComposeRoots()) {
        const target = root.querySelector(
            'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"], .msg-form__contenteditable'
        );
        if (target) return target;
    }

    return null;
}

function setNativeInputValue(target, value) {
    const prototype = target.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (valueSetter) {
        valueSetter.call(target, value);
    } else {
        target.value = value;
    }
}

function fillTextTarget(target, text) {
    target.focus();

    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
        setNativeInputValue(target, text);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return;
    }

    // contenteditable. LinkedIn's message box is a Lexical-style editor; its
    // placeholder is hidden via internal state, NOT by DOM emptiness. Wiping
    // textContent and inserting nodes directly leaves the editor's state stale
    // and the placeholder visible BEHIND the text.
    //
    // Solution: replace the existing content via the editor's own input pipeline
    // by selecting everything and dispatching a paste-equivalent through
    // execCommand. This fires beforeinput / input with the right inputType so
    // the editor updates its state and hides the placeholder.

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);

    let pasted = false;
    try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData("text/plain", text);
        const pasteEvent = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dataTransfer
        });
        pasted = !target.dispatchEvent(pasteEvent);
    } catch (_) {
        pasted = false;
    }

    if (!pasted) {
        // execCommand path. selectAll → insertText replaces the selection
        // through the editor's input pipeline.
        document.execCommand("selectAll", false);
        const inserted = document.execCommand("insertText", false, text);
        if (!inserted) {
            target.textContent = text;
        }
    }

    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

async function fillMessageBoxWithTemplate(template, options = {}) {
    const target = getMessageInputTarget({ ignoreActive: options.ignoreActive === true });
    if (!target) {
        showStatus("No message box found.", true);
        return false;
    }

    const personalizedText = await personalizeTemplate(template, options);
    fillTextTarget(target, personalizedText);
    showStatus(options.successMessage || "Message inserted.");
    return true;
}

function getProfileMessageButton() {
    const topCard = getProfileTopCardRoot();
    const topCardButton = findTextActionInRoot(topCard, ["Message"], { exact: true }) ||
        findButtonInRoot(topCard, ["Message"], { exact: true });
    if (topCardButton) return topCardButton;

    const selectors = [
        'main button[aria-label^="Message "]',
        'main button[aria-label*=" Message "]',
        'main button:has([data-test-icon="send-privately-small"])',
        'button[aria-label^="Message "]',
        'button:has([data-test-icon="send-privately-small"])'
    ];

    for (const selector of selectors) {
        try {
            const button = document.querySelector(selector);
            if (button && isActionCandidate(button)) return button;
        } catch (error) {
            // Some Chromium builds may not support :has().
        }
    }

    const icon = document.querySelector('[data-test-icon="send-privately-small"]');
    const button = icon?.closest?.("button");
    return button && isActionCandidate(button) ? button : null;
}

async function openMessageBox() {
    const browserMode = await getBrowserMode();
    const directMessageButton = browserMode === BROWSER_MODE_VM
        ? findVmProfileHeaderButton(["Message"], { exact: true }) || getProfileMessageButton()
        : getProfileMessageButton() || findProfileHeaderButton(["Message"], { exact: true });

    if (directMessageButton && activateElement(directMessageButton)) {
        showStatus("Message box opened.");
        return true;
    }

    if (browserMode === BROWSER_MODE_VM && clickLinkedInButton(["Message"], { exact: true })) {
        showStatus("Message box opened.");
        return true;
    }

    const topCard = getProfileTopCardRoot();
    const moreButton = browserMode === BROWSER_MODE_VM
        ? findVmProfileHeaderButton(["More actions", "More"]) || findProfileHeaderButton(["More actions", "More"])
        : findTextActionInRoot(topCard, ["More actions", "More"], { exact: true }) ||
            findButtonInRoot(topCard, ["More actions", "More"], { exact: true }) ||
            findProfileHeaderButton(["More actions", "More"]);
    const openedMore = moreButton ? activateElement(moreButton) : false;
    if (!openedMore) {
        showStatus("Message action not found.", true);
        return false;
    }

    await sleep(160);
    const clicked = clickOpenProfileMenuAction(moreButton, ["Message"], { exact: true }) ||
        clickLinkedInButton(["Message"], { exact: true });
    showStatus(clicked ? "Message box opened." : "Message action not found.", !clicked);
    return clicked;
}

function clickSendMessageButton() {
    for (const root of getComposeRoots()) {
        const clicked = clickButtonInRoot(root, ["Send message", "Send"], { exact: true });
        if (clicked) return true;
    }

    const sendIcon = document.querySelector('[data-test-icon*="send"], .msg-form__send-button');
    const sendButton = sendIcon?.closest?.("button") || sendIcon;
    return sendButton && isActionCandidate(sendButton) ? activateElement(sendButton) : false;
}

function getConversationTitleInputTarget() {
    for (const root of getComposeRoots()) {
        const candidates = Array.from(root.querySelectorAll("input, textarea")).filter(isActionCandidate);
        const target = candidates.find((candidate) => {
            const text = [
                candidate.getAttribute("aria-label"),
                candidate.getAttribute("placeholder"),
                candidate.getAttribute("name"),
                candidate.getAttribute("id"),
                candidate.getAttribute("title")
            ].join(" ").toLowerCase();
            return text.includes("subject") || text.includes("group name") || text.includes("thread");
        });
        if (target) return target;
    }

    return null;
}

function getRecipientSearchInputTarget() {
    for (const root of getComposeRoots()) {
        const candidates = Array.from(root.querySelectorAll('input[type="text"], input[role="combobox"]')).filter(isActionCandidate);
        const target = candidates.find((candidate) => {
            const text = [
                candidate.getAttribute("aria-label"),
                candidate.getAttribute("placeholder"),
                candidate.getAttribute("class"),
                candidate.getAttribute("id")
            ].join(" ").toLowerCase();
            return text.includes("enter message recipients") || text.includes("msg-connections-typeahead__search-field");
        });
        if (target) return target;
    }

    return null;
}

async function fillIntroductionTemplate() {
    const introName = await getSavedText(INTRO_NAME_STORAGE_KEY, DEFAULT_INTRO_NAME);
    const subjectTemplate = await getSavedText(INTRO_SUBJECT_TEMPLATE_STORAGE_KEY, DEFAULT_INTRO_SUBJECT_TEMPLATE);
    const bodyTemplate = await getSavedText(INTRO_BODY_TEMPLATE_STORAGE_KEY, DEFAULT_INTRO_BODY_TEMPLATE);
    const recipientTarget = getRecipientSearchInputTarget();
    const hasRecipient = hasSelectedRecipient(introName);

    if (!hasRecipient && recipientTarget && introName) {
        fillTextTarget(recipientTarget, introName);
        await sleep(450);

        if (selectExactRecipientResult(introName)) {
            await sleep(300);
        } else {
            showStatus("Recipient search filled. Select the correct person, then press Option + I again.");
            return true;
        }
    }

    if (!hasSelectedRecipient(introName)) {
        showStatus("Select the intro recipient, then press Option + I again.");
        return true;
    }

    const subjectTarget = getConversationTitleInputTarget();
    const subject = await personalizeTemplate(subjectTemplate, { introName });

    if (subjectTarget) {
        fillTextTarget(subjectTarget, subject);
    }

    const bodyInserted = await fillMessageBoxWithTemplate(bodyTemplate, {
        introName,
        ignoreActive: true,
        successMessage: getIntroSuccessMessage(Boolean(recipientTarget), Boolean(subjectTarget))
    });

    if (!bodyInserted) return false;
    return true;
}

function hasSelectedRecipient(introName) {
    const normalizedIntroName = normalizeName(introName);
    const selectedRecipientButtons = Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__added-recipients button[aria-label^="Remove"], button.artdeco-pill[aria-label^="Remove"]'
    ));

    if (selectedRecipientButtons.length === 0) return false;
    if (!normalizedIntroName) return true;

    return selectedRecipientButtons.some((button) => normalizeName(button.getAttribute("aria-label")).includes(normalizedIntroName));
}

function selectExactRecipientResult(introName) {
    const normalizedIntroName = normalizeName(introName);
    if (!normalizedIntroName) return false;

    const roots = Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
    ));
    const searchRoots = roots.length ? roots : [document];

    for (const root of searchRoots) {
        const candidates = Array.from(root.querySelectorAll(
            'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
        )).filter(isActionCandidate);

        const exactMatch = candidates.find((candidate) => {
            const text = normalizeName(candidate.innerText || candidate.textContent);
            return text === normalizedIntroName || text.startsWith(`${normalizedIntroName} `);
        });

        if (exactMatch) {
            activateElement(exactMatch);
            return true;
        }
    }

    return false;
}

function normalizeName(value) {
    return (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/^remove\s+/, "")
        .replace(/[^a-z0-9\s'-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getIntroSuccessMessage(hasRecipient, hasSubject) {
    if (hasRecipient && hasSubject) return "Intro group title and body inserted.";
    if (hasSubject) return "Intro group title and body inserted.";
    if (hasRecipient) return "Intro recipient search and body inserted.";
    return "Intro body inserted. Recipient/title fields not found.";
}

async function runAction(action, eventTarget = null) {
    if (window.__ORTUS_DM_ASSISTANT_VERSION__ !== ORTUS_DM_CONTENT_VERSION) return;

    if (!(await isExtensionEnabled())) {
        showStatus("Ortus DM extension paused.");
        return;
    }

    switch (action) {
        case "openMessage":
            if (isTypingTarget(eventTarget)) return;
            await openMessageBox();
            break;
        case "pasteDm":
            await fillMessageBoxWithTemplate(await getSavedText(DM_TEMPLATE_STORAGE_KEY, DEFAULT_DM_TEMPLATE), {
                successMessage: "DM inserted."
            });
            break;
        case "pasteIntro":
            await fillIntroductionTemplate();
            break;
        case "sendMessage":
            if (!clickSendMessageButton()) {
                showStatus("Send message action not found.", true);
            } else {
                showStatus("Message sent.");
            }
            break;
        default:
            break;
    }
}

function showStatus(message, isError = false) {
    const id = "ortus-dm-status-toast";
    let toast = document.getElementById(id);
    if (!toast) {
        toast = document.createElement("div");
        toast.id = id;
        toast.setAttribute("role", "status");
        toast.style.cssText = [
            "position:fixed",
            "right:18px",
            "bottom:18px",
            "z-index:2147483647",
            "max-width:280px",
            "padding:10px 12px",
            "border-radius:10px",
            "font:600 13px/1.35 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
            "box-shadow:0 14px 34px rgba(8,12,20,.28)",
            "transition:opacity 160ms ease,transform 160ms ease",
            "opacity:0",
            "transform:translateY(8px)"
        ].join(";");
        document.documentElement.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.color = "#fff";
    toast.style.background = isError ? "#9f2539" : "#12345f";
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";

    window.clearTimeout(showStatus.timeout);
    showStatus.timeout = window.setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(8px)";
    }, 1800);
}

function getProfileNameFromPage() {
    if (!/\/in\//.test(location.pathname)) return "";
    const h1 = document.querySelector("main h1")
            || document.querySelector("h1.text-heading-xlarge")
            || document.querySelector("h1");
    return (h1?.textContent || "").trim();
}

function buildDiagnosticsReport() {
    return {
        version: ORTUS_DM_CONTENT_VERSION,
        url: location.href,
        path: location.pathname,
        profileName: getProfileNameFromPage(),
        hasMessageButton: !!document.querySelector('button[aria-label*="Message" i]'),
        hasMoreButton: !!document.querySelector('button[aria-label*="More actions" i]'),
        timestamp: new Date().toISOString()
    };
}

function isDmMessageSource(source) {
    if (!source) return false;
    if (source === "ortus-dm") return true;
    return source.startsWith("ortus-dm:");
}


// Expose what sendMessage needs (chrome.runtime listener stripped):
window.__ortusDM = { openMessageBox, getMessageInputTarget, fillTextTarget, clickSendMessageButton };
