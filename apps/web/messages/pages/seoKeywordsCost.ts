import { namespace } from "./define";

// Agency money text for keyword research (/seo/keywords): the price line and charged amounts.
// Deliberately in no message set (messages/client.ts): a client viewer must not receive these strings.
// Staff get them from SeoStaffMessages (components/seo). Hindi and Spanish are MACHINE DRAFTS.
export default namespace({
  en: {
    price: {
      label: "Search price",
      line: "This search costs about {price} from your credit (balance {balance}).",
      lineNoBalance: "This search costs about {price}.",
      cached: "Free: you ran this search on {date}.",
      running: "This search is already running. It costs nothing more.",
      sample: "Free in sample mode. A live search would cost about {price}.",
      exceed: "This is more than your remaining monthly budget.",
      checking: "Checking the price...",
      retry: "Try again",
    },
    errors: {
      credit: "There is not enough credit for this search. Add credit and try again.",
      budget: "This search would go over your monthly spending limit for paid lookups. An owner can raise the limit, or you can try again next month.",
      platform: "Keyword research is paused for today across the whole service. It resumes at 00:00 UTC.",
      forbidden: "You do not have permission to run keyword research here.",
    },
    history: { charged: "Charged {price}" },
  },
  hi: {
    price: {
      label: "खोज की कीमत",
      line: "इस खोज में आपके क्रेडिट से लगभग {price} लगेंगे (बैलेंस {balance})।",
      lineNoBalance: "इस खोज में लगभग {price} लगेंगे।",
      cached: "मुफ़्त: आपने यह खोज {date} को चलाई थी।",
      running: "यह खोज पहले से चल रही है। इसकी और कोई लागत नहीं है।",
      sample: "नमूना मोड में मुफ़्त। असली खोज की लागत लगभग {price} होगी।",
      exceed: "यह आपके बचे हुए मासिक बजट से ज़्यादा है।",
      checking: "कीमत देखी जा रही है...",
      retry: "फिर कोशिश करें",
    },
    errors: {
      credit: "इस खोज के लिए क्रेडिट काफ़ी नहीं है। क्रेडिट जोड़ें और फिर कोशिश करें।",
      budget: "यह खोज पेड लुकअप की आपकी मासिक खर्च सीमा से ऊपर चली जाएगी। मालिक सीमा बढ़ा सकता है, या अगले महीने फिर कोशिश करें।",
      platform: "आज पूरी सेवा में कीवर्ड रिसर्च रुकी हुई है। यह 00:00 UTC पर फिर शुरू होगी।",
      forbidden: "यहाँ कीवर्ड रिसर्च चलाने की आपको अनुमति नहीं है।",
    },
    history: { charged: "{price} चार्ज हुआ" },
  },
  es: {
    price: {
      label: "Precio de la búsqueda",
      line: "Esta búsqueda cuesta unos {price} de tu crédito (saldo {balance}).",
      lineNoBalance: "Esta búsqueda cuesta unos {price}.",
      cached: "Gratis: hiciste esta búsqueda el {date}.",
      running: "Esta búsqueda ya está en marcha. No cuesta nada más.",
      sample: "Gratis en modo de muestra. Una búsqueda real costaría unos {price}.",
      exceed: "Es más de lo que queda de tu presupuesto mensual.",
      checking: "Comprobando el precio...",
      retry: "Reintentar",
    },
    errors: {
      credit: "No hay crédito suficiente para esta búsqueda. Añade crédito e inténtalo de nuevo.",
      budget: "Esta búsqueda superaría tu límite mensual de gasto en consultas de pago. Un propietario puede subir el límite, o puedes intentarlo el mes que viene.",
      platform: "La investigación de palabras clave está en pausa hoy en todo el servicio. Se reanuda a las 00:00 UTC.",
      forbidden: "No tienes permiso para hacer investigación de palabras clave aquí.",
    },
    history: { charged: "Se cobraron {price}" },
  },
});
