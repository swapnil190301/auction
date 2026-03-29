'use strict';

/**
 * Edit this file to tune the auction for your machine, then restart the server.
 * Purse / base prices / increments apply to new loads and after “Reset auction”.
 */

/** Max players per team (squad size cap). */
const TEAM_SIZE = 10;

/** Starting purse for each team (same for all teams). */
const DEFAULT_PURSE = 10000;

/** Deducted from team purse when the role is filled (see CSV OWNER / CAPTAIN / ICON rows). */
const ROLE_PURSE_CUT = { owner: 500, captain: 1000, icon: 1000 };

const defaultConfig = {
  purse: DEFAULT_PURSE,
  basePrices: { A: 500, B: 400, C: 300 },
  increments: { A: 50, B: 50, C: 50 },
  teamSize: TEAM_SIZE,
};

/** One name per team; length determines how many teams exist. */
const teamNames = ['HG Supreme', 'HG Indians', 'HG Knight Strikers', 'HG Revengers', 'HG Master Blaster', 'HG Stars'];

const roles = ['Batter', 'Bowler', 'All-rounder'];
const tiers = ['A', 'B', 'C'];

/**
 * Player list at server start and after “Reset auction”.
 * Place the file next to package.json (project root). Restart the server after edits.
 */
const PLAYERS_CSV_FILE = 'cricket-players-my-tournament-2026-03-23.csv';

/** Used only if the CSV file is missing or cannot be parsed. */
const sampleNamesFallback = [
  'Samrat', 'Deepak Thakker', 'Amit Naik', 'Nilkanth Wagh', 'Sachin Pandya', 'Pinkesh Pandya', 'Vaidyanath', 'Shailendra Rajeshirke', 'Chetan', 'Harish Pandey', 'Atharva', 'Swapnil Mandivalli', 'Shanyu', 'Ajit Mahadik', 'Vishal B', 'Vishal Patil', 'Atul Vaikul', 'Kiran Chavan', 'Swapnil Deshmukh', 'Shuban', 'OM', 'Suresh (Baba)', 'Pravin (Baba ka Bhakt)', 'Ashish Mishra', 'Milind Muthe', 'Prakash Patil', 'Deepak Khaiwan', 'Tanmay', 'Ajay More', 'Vivek Thakare', 'Mithun Shetty', 'Sunil Waghralkar', 'Mihir Doshi', 'Dinesh Kadam', 'Pradeep Chalke', 'Hemant Narkar', 'Manoj Dabholkar', 'Jayesh Kshirsagarh', 'Shreyas Shinde', 'Ketan Patil', 'Shrikant Salunkhe', 'Anup Magare', 'Paras Kurmi', 'Dinesh Gholap', 'Swapnil Choche', 'Swapnil Gharat', 'Aniket', 'Aditya', 'Swapnil Bondre', 'Ronnel Quadras', 'Aadit B', 'Onkar Dhavale', 'Abhay Patil', 'Parth Patil', 'Navin Bijur',
];

module.exports = {
  TEAM_SIZE,
  DEFAULT_PURSE,
  ROLE_PURSE_CUT,
  defaultConfig,
  teamNames,
  roles,
  tiers,
  PLAYERS_CSV_FILE,
  sampleNamesFallback,
};
