import type { PayrollRatesEdition } from "./types";

/**
 * IRD payroll rates for pay dates 1 April 2026 to 31 March 2027, from IRD's
 * "Payroll Calculations & Business Rules Specification" for that year.
 * Every figure is as printed in the specification; "source" is the section
 * and page. See README.md before changing anything.
 */
export const RATES_2026_27: PayrollRatesEdition = {
  id: "2026-27",
  from: "2026-04-01",
  to: "2027-03-31",
  specification: {
    document: "Payroll Calculations & Business Rules Specification",
    edition: "1 April 2026 to 31 March 2027, version 1.0, dated 24 March 2026",
    url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/software-providers/payroll-calculations-business-rules-specifications/payroll-calculations-and-business-rules-specification.pdf",
    read: "2026-10-01",
    sha256: "4fb1c1ecc760ad7fe7dc912904c76522dee29b282dc9217afeb9b266d9af1dc7",
  },
  crossChecks: [
    {
      document: "Weekly and fortnightly PAYE deduction tables",
      number: "IR340",
      edition: "April 2026 (pay periods between 1 April 2026 and March 2027)",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir340/ir340-apr-2026.pdf",
      read: "2026-10-01",
      sha256: "fdc5d41b17247aaca7fe021ca4c9ded9c7c382515064c6c879ba7c5859667830",
    },
    {
      document: "4 weekly and monthly PAYE deduction tables",
      number: "IR341",
      edition: "April 2026 (pay periods between 1 April 2026 and March 2027)",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir341/ir341-apr-2026.pdf",
      read: "2026-10-01",
      sha256: "1e42abf7e73cba1f82983aa2f0f2c817910604b7341a63458dd2bf486752b52a",
    },
    {
      document: "Employer's guide",
      number: "IR335",
      edition: "September 2026",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir335/ir335.pdf",
      read: "2026-10-01",
      sha256: "b7514882917184bf9e2c266becd567273468111bbea908e69cfc25ab68766896",
    },
    {
      document: "KiwiSaver employer guide",
      number: "KS4",
      edition: "April 2026",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1---ir99/ks4/ks4.pdf",
      read: "2026-10-01",
      sha256: "5d76379b212b16a99a12cbfd51bb0e2386685756d5ef918eb82b3bf96287d0ad",
    },
  ],
  incomeTax: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "2.6, page 8 (from 31 July 2024); 5.2 step 3, page 22",
      value: [
        { from: "0", to: "15600", rate: "10.5", subtract: "0" },
        { from: "15601", to: "53500", rate: "17.5", subtract: "1092.00" },
        { from: "53501", to: "78100", rate: "30", subtract: "7779.50" },
        { from: "78101", to: "180000", rate: "33", subtract: "10122.50" },
        { from: "180001", to: null, rate: "39", subtract: "20922.50" },
      ],
    },
  ],
  accEarnersLevy: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "2.1, page 6; 5.2 step 4, page 22",
      value: { rate: "1.75", maximumLiableEarnings: "156641", maximumLevy: "2741.22" },
    },
  ],
  independentEarnerTaxCredit: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "2.7, page 8 (from 31 July 2024); 5.3 step 4, page 24",
      value: {
        lowerThreshold: "24000",
        upperThreshold: "70000",
        abatementStarts: "66000",
        amount: "520",
        abatementRate: "13",
      },
    },
  ],
  secondaryTaxRates: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "5.1, page 20; 5.6 step 4, page 29",
      value: { SB: "10.5", S: "17.5", SH: "30", ST: "33", SA: "39" },
    },
  ],
  flatTaxRates: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "5.5, pages 26-27 (NSW); 5.7, page 30 (CAE, EDW); 5.8, page 31 (ND)",
      value: { ND: "45", NSW: "10.5", CAE: "17.5", EDW: "17.5" },
    },
  ],
  studentLoan: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "2.2, page 6; 5.4, page 25",
      value: {
        annualRepaymentThreshold: "24128",
        rate: "12",
        payPeriodThresholds: {
          weekly: "464",
          fortnightly: "928",
          "four-weekly": "1856",
          monthly: "2010.66",
        },
      },
    },
  ],
  kiwiSaver: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "2.3, page 7 (paydays on or after 1 April 2026); 4, page 11; 4.2, page 12; 4.3, page 13",
      value: {
        employeeRates: ["3.5", "4", "6", "8", "10"],
        defaultEmployeeRate: "3.5",
        minimumEmployerRate: "3.5",
        temporaryRateReduction: { employeeRate: "3", employerRate: "3" },
      },
    },
  ],
  esct: [
    {
      from: "2026-04-01",
      to: "2027-03-31",
      source: "2.4, page 7 (from 1 April 2025)",
      value: [
        { from: "0", to: "18720", rate: "10.5" },
        { from: "18721", to: "64200", rate: "17.5" },
        { from: "64201", to: "93720", rate: "30" },
        { from: "93721", to: "216000", rate: "33" },
        { from: "216001", to: null, rate: "39" },
      ],
    },
  ],
};
