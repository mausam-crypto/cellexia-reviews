/**
 * Per-locale reviewer name pools for the synthetic review generator
 * (SPEC-1.4 §C). Common, culturally plausible given/family names — chosen to
 * be ordinary (no distinctive real-person combinations). Display formats are
 * rotated by synthetic.server.ts; `formatDisplayName` handles locale display
 * conventions (family-name-first for ja, initials, etc.).
 */

export interface NamePool {
  first: string[];
  last: string[];
}

export const NAME_POOLS: Record<string, NamePool> = {
  en: {
    first: ["Margaret", "Susan", "Karen", "Linda", "Patricia", "Carol", "Janet", "Diane", "Laura", "Sarah", "Emily", "Rachel", "Hannah", "Claire", "Julia", "Grace", "Ellen", "Joan", "Ruth", "Alice", "Michael", "David", "James", "Robert", "Thomas", "Daniel", "Peter", "Andrew", "Paul", "Mark", "Helen", "Catherine", "Rebecca", "Angela", "Christine", "Nancy", "Deborah", "Sandra"],
    last: ["Ellison", "Whitmore", "Carter", "Bennett", "Hayes", "Sullivan", "Porter", "Mitchell", "Turner", "Brooks", "Reed", "Coleman", "Barnes", "Fletcher", "Griffin", "Chambers", "Lawson", "Palmer"],
  },
  fr: {
    first: ["Marie", "Nathalie", "Isabelle", "Sylvie", "Catherine", "Françoise", "Valérie", "Christine", "Sophie", "Céline", "Anne", "Brigitte", "Hélène", "Claire", "Camille", "Élodie", "Aurélie", "Julie", "Pascale", "Dominique", "Jean", "Pierre", "Michel", "Philippe", "Alain", "Bernard", "Laurent", "Nicolas", "Éric", "Olivier", "Martine", "Monique", "Chantal", "Véronique", "Sandrine", "Delphine"],
    last: ["Lefèvre", "Moreau", "Fournier", "Girard", "Bonnet", "Dupont", "Lambert", "Rousseau", "Vincent", "Muller", "Faure", "Blanchard", "Garnier", "Chevalier", "Perrin", "Clément"],
  },
  de: {
    first: ["Sabine", "Monika", "Petra", "Andrea", "Claudia", "Birgit", "Karin", "Susanne", "Martina", "Angelika", "Heike", "Gabriele", "Anja", "Katrin", "Silke", "Christiane", "Ute", "Renate", "Barbara", "Ingrid", "Thomas", "Michael", "Andreas", "Stefan", "Wolfgang", "Klaus", "Jürgen", "Peter", "Frank", "Markus", "Julia", "Stefanie", "Nicole", "Sandra", "Melanie", "Kerstin"],
    last: ["Schneider", "Hoffmann", "Fischer", "Weber", "Wagner", "Becker", "Schulz", "Richter", "Koch", "Bauer", "Klein", "Wolf", "Neumann", "Schwarz", "Zimmermann", "Krüger"],
  },
  es: {
    first: ["Carmen", "María", "Pilar", "Teresa", "Rosa", "Ana", "Isabel", "Dolores", "Cristina", "Marta", "Elena", "Beatriz", "Silvia", "Nuria", "Montserrat", "Lucía", "Paloma", "Amparo", "Inés", "Alicia", "José", "Antonio", "Manuel", "Francisco", "Javier", "Carlos", "Miguel", "Rafael", "Fernando", "Alberto", "Raquel", "Patricia", "Susana", "Mercedes", "Rocío", "Almudena"],
    last: ["García", "Fernández", "Martínez", "Sánchez", "Romero", "Navarro", "Torres", "Domínguez", "Vázquez", "Serrano", "Molina", "Delgado", "Ortega", "Castro", "Rubio", "Iglesias"],
  },
  it: {
    first: ["Maria", "Anna", "Giovanna", "Rosa", "Francesca", "Laura", "Paola", "Carla", "Elena", "Silvia", "Chiara", "Federica", "Alessandra", "Roberta", "Simona", "Daniela", "Cristina", "Stefania", "Monica", "Elisabetta", "Giuseppe", "Marco", "Andrea", "Francesco", "Luca", "Paolo", "Roberto", "Stefano", "Alessandro", "Davide", "Valentina", "Giulia", "Martina", "Serena", "Ilaria", "Barbara"],
    last: ["Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca", "Costa", "Giordano", "Rizzo", "Lombardi", "Moretti", "Barbieri", "Fontana", "Santoro", "Mariani"],
  },
  nl: {
    first: ["Annemarie", "Ingrid", "Marieke", "Sandra", "Monique", "Petra", "Karin", "Linda", "Esther", "Wendy", "Judith", "Saskia", "Anouk", "Femke", "Marjolein", "Ellen", "Nicole", "Angela", "Jacqueline", "Yvonne", "Jan", "Peter", "Hans", "Erik", "Mark", "Paul", "Rob", "Frank", "Dennis", "Martin", "Els", "Corrie", "Willemien", "Tineke", "Gerda", "Ria"],
    last: ["de Vries", "Jansen", "van den Berg", "Bakker", "Visser", "Smit", "Meijer", "Mulder", "Bos", "Vos", "Peters", "Hendriks", "Dekker", "Verhoeven", "Kuipers", "Prins"],
  },
  da: {
    first: ["Anne", "Kirsten", "Mette", "Hanne", "Lene", "Susanne", "Birgitte", "Charlotte", "Pia", "Louise", "Camilla", "Maria", "Lars", "Peter", "Henrik", "Søren"],
    last: ["Nielsen", "Jensen", "Hansen", "Pedersen", "Andersen", "Christensen", "Larsen", "Sørensen"],
  },
  sv: {
    first: ["Anna", "Eva", "Maria", "Karin", "Lena", "Ingrid", "Christina", "Birgitta", "Sofia", "Emma", "Åsa", "Helena", "Lars", "Anders", "Johan", "Erik"],
    last: ["Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson", "Olsson", "Persson"],
  },
  fi: {
    first: ["Anneli", "Marjatta", "Kaarina", "Helena", "Johanna", "Hannele", "Ritva", "Pirjo", "Sari", "Minna", "Tuula", "Päivi", "Juha", "Matti", "Timo", "Antti"],
    last: ["Korhonen", "Virtanen", "Mäkinen", "Nieminen", "Mäkelä", "Hämäläinen", "Laine", "Heikkinen"],
  },
  ar: {
    first: ["فاطمة", "مريم", "عائشة", "زينب", "خديجة", "سارة", "نور", "ليلى", "هدى", "أمينة", "رانيا", "دينا", "محمد", "أحمد", "علي", "عمر"],
    last: ["الأحمد", "الخطيب", "حداد", "نصار", "عبدالله", "السيد", "منصور", "شاهين"],
  },
  pl: {
    first: ["Anna", "Maria", "Katarzyna", "Małgorzata", "Agnieszka", "Barbara", "Ewa", "Krystyna", "Magdalena", "Joanna", "Aleksandra", "Monika", "Piotr", "Krzysztof", "Andrzej", "Tomasz"],
    last: ["Kowalska", "Nowak", "Wiśniewska", "Wójcik", "Kowalczyk", "Kamińska", "Lewandowska", "Zielińska"],
  },
  "pt-PT": {
    first: ["Maria", "Ana", "Isabel", "Teresa", "Manuela", "Fernanda", "Cristina", "Paula", "Sofia", "Marta", "Catarina", "Inês", "João", "António", "Manuel", "Pedro"],
    last: ["Silva", "Santos", "Ferreira", "Pereira", "Oliveira", "Costa", "Rodrigues", "Martins"],
  },
  ja: {
    first: ["由美", "恵子", "直子", "裕子", "真理", "陽子", "久美子", "美穂", "彩", "さくら", "遥", "美咲", "健", "誠", "浩", "隆"],
    last: ["佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村"],
  },
  nb: {
    first: ["Anne", "Inger", "Kari", "Marit", "Ingrid", "Liv", "Eva", "Berit", "Astrid", "Solveig", "Nina", "Hilde", "Lars", "Per", "Bjørn", "Ole"],
    last: ["Hansen", "Johansen", "Olsen", "Larsen", "Andersen", "Pedersen", "Nilsen", "Berg"],
  },
  ro: {
    first: ["Maria", "Elena", "Ioana", "Ana", "Andreea", "Cristina", "Mihaela", "Gabriela", "Daniela", "Alina", "Simona", "Raluca", "Ion", "Andrei", "Mihai", "Alexandru"],
    last: ["Popescu", "Ionescu", "Popa", "Stan", "Dumitrescu", "Gheorghiu", "Constantin", "Marin"],
  },
  hu: {
    first: ["Mária", "Erzsébet", "Katalin", "Éva", "Ilona", "Anna", "Zsuzsanna", "Judit", "Ágnes", "Andrea", "Krisztina", "Eszter", "László", "István", "József", "Zoltán"],
    last: ["Nagy", "Kovács", "Tóth", "Szabó", "Horváth", "Varga", "Kiss", "Molnár"],
  },
  el: {
    first: ["Μαρία", "Ελένη", "Κατερίνα", "Σοφία", "Γεωργία", "Δήμητρα", "Αγγελική", "Βασιλική", "Ειρήνη", "Αναστασία", "Χριστίνα", "Ευαγγελία", "Γιώργος", "Δημήτρης", "Νίκος", "Κώστας"],
    last: ["Παπαδοπούλου", "Παππά", "Νικολάου", "Γεωργίου", "Δημητρίου", "Αντωνίου", "Οικονόμου", "Καραγιάννη"],
  },
};

export type DisplayFormat = "first" | "first_initial" | "full" | "initial_last";

export const DISPLAY_FORMATS: readonly DisplayFormat[] = [
  "first",
  "first_initial",
  "full",
  "initial_last",
] as const;

/**
 * Locale-aware display-name rendering. `ja` uses family-name-first with an
 * ideographic space and never abbreviates; Arabic and Greek skip Latin-style
 * initials (an initial+dot reads unnatural) and fall back to fuller forms.
 */
export function formatDisplayName(
  locale: string,
  first: string,
  last: string,
  format: DisplayFormat,
): string {
  if (locale === "ja") {
    return format === "first" ? first : `${last}　${first}`;
  }
  const noInitials = locale === "ar" || locale === "el";
  switch (format) {
    case "first":
      return first;
    case "first_initial":
      return noInitials ? `${first} ${last}` : `${first} ${last.charAt(0)}.`;
    case "initial_last":
      return noInitials ? `${first} ${last}` : `${first.charAt(0)}. ${last}`;
    case "full":
    default:
      return `${first} ${last}`;
  }
}

/** Pool lookup with a safe fallback to English for unexpected locales. */
export function poolFor(locale: string): NamePool {
  return NAME_POOLS[locale] ?? NAME_POOLS.en;
}
