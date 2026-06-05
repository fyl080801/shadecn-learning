import type { MentionItem } from './types'

/**
 * Trimmed sample data set — same Star Wars flavour as Slate's example,
 * but only ~36 entries so the suggestion list is comfortable to eyeball
 * during development.  The search behaviour is identical (case-insensitive
 * prefix match), so swapping this for the full 400+ list is a one-liner.
 */
export const CHARACTERS: MentionItem[] = [
  { id: 'aayla-secura', character: 'Aayla Secura' },
  { id: 'admiral-ackbar', character: 'Admiral Ackbar' },
  { id: 'ahsoka-tano', character: 'Ahsoka Tano' },
  { id: 'anakin-skywalker', character: 'Anakin Skywalker' },
  { id: 'asajj-ventress', character: 'Asajj Ventress' },
  { id: 'bb-8', character: 'BB-8' },
  { id: 'boba-fett', character: 'Boba Fett' },
  { id: 'c-3po', character: 'C-3PO' },
  { id: 'caper-freemaker', character: 'Caper Freemaker' },
  { id: 'chewbacca', character: 'Chewbacca' },
  { id: 'darth-maul', character: 'Darth Maul' },
  { id: 'darth-vader', character: 'Darth Vader' },
  { id: 'dooku', character: 'Count Dooku' },
  { id: 'finn', character: 'Finn' },
  { id: 'general-grievous', character: 'General Grievous' },
  { id: 'han-solo', character: 'Han Solo' },
  { id: 'jabba', character: 'Jabba' },
  { id: 'jango-fett', character: 'Jango Fett' },
  { id: 'k-2so', character: 'K-2SO' },
  { id: 'kit-fisto', character: 'Kit Fisto' },
  { id: 'kylo-ren', character: 'Kylo Ren' },
  { id: 'lando-calrissian', character: 'Lando Calrissian' },
  { id: 'luke-skywalker', character: 'Luke Skywalker' },
  { id: 'mace-windu', character: 'Mace Windu' },
  { id: 'mandalorian', character: 'The Mandalorian' },
  { id: 'obi-wan-kenobi', character: 'Obi-Wan Kenobi' },
  { id: 'padme-amidala', character: 'Padmé Amidala' },
  { id: 'palpatine', character: 'Palpatine' },
  { id: 'poe-dameron', character: 'Poe Dameron' },
  { id: 'qui-gon-jinn', character: 'Qui-Gon Jinn' },
  { id: 'r2-d2', character: 'R2-D2' },
  { id: 'rey', character: 'Rey' },
  { id: 'sabine-wren', character: 'Sabine Wren' },
  { id: 'ahsoka-tano-2', character: 'Ahsoka Tano (Rebels)' },
  { id: 'ahsoka-tano-3', character: 'Ahsoka Tano (Mandalorian)' },
  { id: 'yoda', character: 'Yoda' }
]

/** Synchronous source compatible with the source prop on <MentionEditor>. */
export const characterSource = (search: string): MentionItem[] =>
  CHARACTERS.filter((c) =>
    c.character.toLowerCase().startsWith(search.toLowerCase())
  )
