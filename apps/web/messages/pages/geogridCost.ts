import { namespace } from "./define";

// Agency money text for rank tracking (/geogrid): budget, markup, key resale and charged amounts.
// Deliberately in no message set (messages/client.ts): no layout serializes it
// into a page's HTML, and a client viewer must not receive these strings.
// Staff get them from getTranslations("geogridCost") or from StaffMessages (components/rank-tracking).
// Hindi and Spanish are MACHINE DRAFTS. English is character for character what the page showed.
export default namespace({
  en: {
    budget: {
      panelLabel: "Budget panel",
      heading: "Budget",
      formLabel: "Budget",
      monthly: "Monthly budget (USD)",
      markup: "Markup (%)",
      monthLine: "This month: {spent} of {budget} budget. Markup {markup}%.",
      monthLineDefaults: "This month: {spent} of {budget} budget. Markup {markup}% (defaults).",
    },
    speed: {
      heading: "Scan speed",
      standard: "Standard speed",
      fast: "Fast",
      option: "{name}: {price} · about {minutes} min",
      defaultLabel: "Default scan speed",
      defaultHint: "Scheduled runs always use this speed; it is pre-selected when you run by hand.",
      defaultOption: "{name} ({price} per point, about {minutes} min)",
      refreshLabel: "Default for new trackers: refresh competitor profiles",
      refreshOff: "Off, refresh by hand",
      refreshWeekly: "Refresh weekly",
      refreshHint: "Weekly uses credits on live data: about {amount} per tracker per week. This only sets the starting choice for new trackers; trackers you already have keep theirs.",
    },
    cost: {
      howOwn: "your own key, no markup",
      howMarkup: "includes {markup}% markup",
      budgetLine: "This month so far {spent} of {budget}; {left} left.",
      exceed: "This would exceed the monthly budget and will be refused.",
    },
    key: {
      none: "No key set: runs use our key with the markup.",
      resold: "Our key (with markup)",
      explain:
        "With your own key, Maps-rank runs are paid from your DataForSEO account, billed here at cost with no markup, and do not count against the monthly budget.",
      confirmRemove: "Remove your DataForSEO key? Runs will use our key with the markup.",
    },
    usage: {
      note: "Runs on your own key are not part of the monthly budget above.",
      charged: "Charged",
    },
    history: {
      charged: "Charged",
    },
    scan: {
      intro: "Scan any business, such as a prospect, without adding it as a location. Scans use the same budget and prices as trackers.",
    },
  },
  hi: {
    budget: {
      panelLabel: "बजट पैनल",
      heading: "बजट",
      formLabel: "बजट",
      monthly: "मासिक बजट (USD)",
      markup: "मार्कअप (%)",
      monthLine: "इस महीने: {budget} के बजट में से {spent}। मार्कअप {markup}%।",
      monthLineDefaults: "इस महीने: {budget} के बजट में से {spent}। मार्कअप {markup}% (डिफ़ॉल्ट)।",
    },
    speed: {
      heading: "स्कैन की गति",
      standard: "सामान्य गति",
      fast: "तेज़",
      option: "{name}: {price} · लगभग {minutes} मिनट",
      defaultLabel: "डिफ़ॉल्ट स्कैन गति",
      defaultHint: "शेड्यूल किए गए रन हमेशा यही गति इस्तेमाल करते हैं; हाथ से चलाते समय यह पहले से चुनी होती है।",
      defaultOption: "{name} (प्रति बिंदु {price}, लगभग {minutes} मिनट)",
      refreshLabel: "नए ट्रैकर के लिए डिफ़ॉल्ट: प्रतिस्पर्धी प्रोफ़ाइल ताज़ा करना",
      refreshOff: "बंद, हाथ से ताज़ा करें",
      refreshWeekly: "हर हफ़्ते ताज़ा करें",
      refreshHint: "हर हफ़्ते वाला विकल्प लाइव डेटा पर क्रेडिट इस्तेमाल करता है: प्रति ट्रैकर प्रति सप्ताह लगभग {amount}। यह केवल नए ट्रैकर की शुरुआती पसंद तय करता है; आपके मौजूदा ट्रैकर अपनी पसंद रखते हैं।",
    },
    cost: {
      howOwn: "आपकी अपनी कुंजी, कोई मार्कअप नहीं",
      howMarkup: "{markup}% मार्कअप शामिल",
      budgetLine: "इस महीने अब तक {budget} में से {spent}; {left} बाकी।",
      exceed: "यह मासिक बजट से ज़्यादा होगा और अस्वीकार कर दिया जाएगा।",
    },
    key: {
      none: "कोई कुंजी सेट नहीं: रन हमारी कुंजी और मार्कअप के साथ चलते हैं।",
      resold: "हमारी कुंजी (मार्कअप के साथ)",
      explain:
        "अपनी कुंजी के साथ, Maps-रैंक रन का भुगतान आपके DataForSEO खाते से होता है, यहाँ बिना मार्कअप के लागत पर बिल बनता है, और ये मासिक बजट में नहीं गिने जाते।",
      confirmRemove: "अपनी DataForSEO कुंजी हटाएँ? रन हमारी कुंजी और मार्कअप के साथ चलेंगे।",
    },
    usage: {
      note: "अपनी कुंजी वाले रन ऊपर के मासिक बजट में शामिल नहीं हैं।",
      charged: "लिया गया शुल्क",
    },
    history: {
      charged: "लिया गया शुल्क",
    },
    scan: {
      intro: "किसी भी बिज़नेस, जैसे संभावित ग्राहक, को स्थान के रूप में जोड़े बिना स्कैन करें। स्कैन में ट्रैकर वाला ही बजट और कीमतें लगती हैं।",
    },
  },
  es: {
    budget: {
      panelLabel: "Panel de presupuesto",
      heading: "Presupuesto",
      formLabel: "Presupuesto",
      monthly: "Presupuesto mensual (USD)",
      markup: "Margen (%)",
      monthLine: "Este mes: {spent} de {budget} de presupuesto. Margen {markup}%.",
      monthLineDefaults: "Este mes: {spent} de {budget} de presupuesto. Margen {markup}% (predeterminado).",
    },
    speed: {
      heading: "Velocidad del escaneo",
      standard: "Velocidad estándar",
      fast: "Rápida",
      option: "{name}: {price} · unos {minutes} min",
      defaultLabel: "Velocidad de escaneo predeterminada",
      defaultHint: "Las ejecuciones programadas siempre usan esta velocidad; viene preseleccionada al ejecutar a mano.",
      defaultOption: "{name} ({price} por punto, unos {minutes} min)",
      refreshLabel: "Predeterminado para rastreadores nuevos: actualizar perfiles de competidores",
      refreshOff: "Desactivado, actualizar a mano",
      refreshWeekly: "Actualizar cada semana",
      refreshHint: "Cada semana usa creditos con datos reales: unos {amount} por rastreador a la semana. Solo fija la opcion inicial de los rastreadores nuevos; los que ya tienes conservan la suya.",
    },
    cost: {
      howOwn: "tu propia clave, sin margen",
      howMarkup: "incluye {markup}% de margen",
      budgetLine: "Este mes hasta ahora {spent} de {budget}; quedan {left}.",
      exceed: "Esto superaría el presupuesto mensual y será rechazado.",
    },
    key: {
      none: "Sin clave: las ejecuciones usan nuestra clave con el margen.",
      resold: "Nuestra clave (con margen)",
      explain:
        "Con tu propia clave, las ejecuciones de posición en Maps se pagan desde tu cuenta de DataForSEO, se facturan aquí a costo y sin margen, y no cuentan para el presupuesto mensual.",
      confirmRemove: "¿Quitar tu clave de DataForSEO? Las ejecuciones usarán nuestra clave con el margen.",
    },
    usage: {
      note: "Las ejecuciones con tu propia clave no forman parte del presupuesto mensual de arriba.",
      charged: "Cobrado",
    },
    history: {
      charged: "Cobrado",
    },
    scan: {
      intro: "Escanea cualquier negocio, como un prospecto, sin añadirlo como ubicación. Los escaneos usan el mismo presupuesto y precios que los rastreadores.",
    },
  },
});
