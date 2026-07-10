/**
 * Shared landing-page renderer for the Cardiac CRM Toolkit.
 * ---------------------------------------------------------
 * Define every tool card ONCE in the TOOLS array below. Both the public
 * index (/index.html) and the gated developer deck (/dev/index.html) render
 * from this same file, so adding or editing a tool is a one-place change.
 *
 *   renderHome({ includeDevLink:true });                    // public index (root)
 *   renderHome({ includeDev:true, base:"../", eyebrow:"…" }); // /dev/ deck
 *
 * PATHS: card/link targets below are RELATIVE (no leading slash). Each page
 * passes `base` for its folder depth ("" at the site root, "../" one level
 * deep like /dev/). That way the same file works both when opened directly
 * (file://) and when served from a web root (Cloudflare Pages).
 *
 * Flags on a tool:
 *   dev:true   -> only shown on the developer deck (and gated by Access)
 */
(function () {
  "use strict";

  // ---- Icons (kept as markup so each card can carry its own) ----
  var STAR = '<span class="star4"></span>';
  var CRM_ICON =
    '<svg viewBox="0 0 64 64" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<g stroke="#f5ead0" stroke-width="6" stroke-linecap="round">' +
        '<line x1="14" y1="18" x2="50" y2="52"/>' +
        '<line x1="50" y1="18" x2="14" y2="52"/>' +
      '</g>' +
      '<circle cx="32" cy="33" r="15" fill="#f5ead0"/>' +
      '<rect x="26" y="44" width="12" height="8" rx="3" fill="#f5ead0"/>' +
      '<circle cx="26.5" cy="32" r="3.4" fill="#0b2230"/>' +
      '<circle cx="37.5" cy="32" r="3.4" fill="#0b2230"/>' +
      '<path d="M32 36.5 l-2.5 4.8 h5 z" fill="#0b2230"/>' +
      '<ellipse cx="32" cy="17" rx="12" ry="8.5" fill="#edc768" stroke="#8f6a1e" stroke-width="1.5"/>' +
      '<ellipse cx="32" cy="19.5" rx="11.5" ry="3.6" fill="#c0392b"/>' +
      '<ellipse cx="32" cy="22" rx="19" ry="4.6" fill="#e6bd55" stroke="#8f6a1e" stroke-width="1.5"/>' +
    '</svg>';

  // ============================ EDIT TOOLS HERE ============================
  var TOOLS = [
    {
      href: "app/CRM_Report_Generator.html",
      kicker: "Wanted &mdash; Dead or Alive",
      title: "CRM Report Generator",
      bounty: "&#3647; 3,000,000,000 &middot; The Flagship",
      icon: CRM_ICON,
    },
    {
      href: "app/Mileage_Calculator.html",
      kicker: "Wanted &mdash; Dead or Alive",
      title: "Mileage Calculator",
      bounty: "&#3647; 1,500,000,000 &middot; The Log Pose",
      icon: STAR,
    },
    {
      href: "dev/dashboard.html",
      kicker: "Wanted &mdash; Dead or Alive",
      title: "Dashboard",
      bounty: "&#3647; 5,000,000,000 &middot; The Command Deck",
      icon: STAR,
      dev: true, // developer-only; lives under the gated /dev/ folder
    },
    {
      href: "dev/Patient_Schedule.html",
      kicker: "Wanted &mdash; Dead or Alive",
      title: "Patient Schedule",
      bounty: "&#3647; 2,000,000,000 &middot; The Crew Manifest",
      icon: STAR,
      dev: true, // developer-only; lives under the gated /dev/ folder
    },
  ];

  // The card shown on the PUBLIC index that leads into the gated deck.
  var DEV_LINK = {
    href: "dev/index.html",
    kicker: "Restricted &mdash; Crew Only",
    title: "Developer Deck",
    bounty: "Requires sign-in",
    icon: STAR,
    locked: true,
  };
  // ========================================================================

  function cardHtml(t, base) {
    return (
      '<a class="btn-sail' + (t.locked ? " locked" : "") + '" href="' + base + t.href + '">' +
        '<span class="b-icon">' + t.icon + "</span>" +
        '<span class="b-text">' +
          '<span class="b-kicker">' + t.kicker + "</span>" +
          '<span class="b-title">' + t.title + "</span>" +
          '<span class="b-bounty">' + t.bounty + "</span>" +
        "</span>" +
        '<span class="b-arrow">&#9658;</span>' +
      "</a>"
    );
  }

  function headerHtml(eyebrow) {
    return (
      '<div class="compass" aria-hidden="true">' +
        '<div class="ring"></div>' +
        '<span class="card-pt n">N</span>' +
        '<span class="card-pt e">E</span>' +
        '<span class="card-pt s">S</span>' +
        '<span class="card-pt w">W</span>' +
        '<div class="star4"></div>' +
      "</div>" +
      '<div class="eyebrow">' + eyebrow + "</div>" +
      '<h1><span class="c-hat">C<svg class="strawhat" viewBox="0 0 64 42" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
        '<ellipse cx="32" cy="22" rx="16" ry="15" fill="#edc768" stroke="#8f6a1e" stroke-width="2"/>' +
        '<ellipse cx="32" cy="26" rx="15.5" ry="6" fill="#c0392b"/>' +
        '<ellipse cx="32" cy="31" rx="29" ry="8" fill="#e6bd55" stroke="#8f6a1e" stroke-width="2"/>' +
      "</svg></span>ardiac CRM<br>Toolkit</h1>" +
      '<div class="rope" aria-hidden="true"></div>'
    );
  }

  window.renderHome = function (opts) {
    opts = opts || {};
    var base = opts.base || "";
    var stage = document.getElementById("stage");
    if (!stage) return;
    var list = TOOLS.filter(function (t) { return opts.includeDev || !t.dev; });
    var cards = list.map(function (t) { return cardHtml(t, base); });
    if (opts.includeDevLink) cards.push(cardHtml(DEV_LINK, base));
    stage.innerHTML =
      headerHtml(opts.eyebrow || "Grand Line Navigation") +
      '<nav class="actions">' + cards.join("") + "</nav>";
  };
})();
