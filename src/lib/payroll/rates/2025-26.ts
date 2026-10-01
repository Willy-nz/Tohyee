import type { PayrollRatesEdition } from "./types";

/**
 * IRD payroll rates for pay dates 1 April 2025 to 31 March 2026, from IRD's
 * "Payroll Calculations & Business Rules Specification" for that year.
 * Every figure is as printed in the specification; "source" is the section
 * and page. See README.md before changing anything.
 */
export const RATES_2025_26: PayrollRatesEdition = {
  id: "2025-26",
  from: "2025-04-01",
  to: "2026-03-31",
  specification: {
    document: "Payroll Calculations & Business Rules Specification",
    edition: "1 April 2025 to 31 March 2026, version 1.0, dated 1 April 2025",
    url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/digital-service-providers/software-providers/payroll-calculations-business-rules-specifications/payroll-calculations-and-business-rules-specification-2026-v1.pdf",
    read: "2026-10-01",
    sha256: "cb6bdb11c0557f6e6667837984d1eeb4a8fcd838a51976235695572372f04d5a",
  },
  crossChecks: [
    {
      document: "Weekly and fortnightly PAYE deduction tables",
      number: "IR340",
      edition: "April 2025 (pay periods between 1 April 2025 and March 2026)",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir340/ir340-2025.pdf",
      read: "2026-10-01",
      sha256: "47cac39d30ee58d5cfd2d9b6481c96b26f41196eb9ed6c1011268664bbe9ea6f",
    },
    {
      document: "4 weekly and monthly PAYE deduction tables",
      number: "IR341",
      edition: "April 2025 (pay periods between 1 April 2025 and March 2026)",
      url: "https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir341/ir341-2025.pdf",
      read: "2026-10-01",
      sha256: "f20427ee0ccdbb771c86d5965d31e9c5dd6ab32d222503a3892fad48d376f4b5",
    },
  ],
  incomeTax: [
    {
      from: "2025-04-01",
      to: "2026-03-31",
      source: "2.5, page 7 (from 31 July 2024); 5.2 step 3, page 16",
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
      from: "2025-04-01",
      to: "2026-03-31",
      source: "2.1, page 6; 5.2 step 4, page 16",
      value: { rate: "1.67", maximumLiableEarnings: "152790", maximumLevy: "2551.59" },
    },
  ],
  independentEarnerTaxCredit: [
    {
      from: "2025-04-01",
      to: "2026-03-31",
      source: "2.6, page 7 (from 31 July 2024); 5.3 step 4, page 18",
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
      from: "2025-04-01",
      to: "2026-03-31",
      source: "5.1, page 14; 5.6 step 4, page 23",
      value: { SB: "10.5", S: "17.5", SH: "30", ST: "33", SA: "39" },
    },
  ],
  flatTaxRates: [
    {
      from: "2025-04-01",
      to: "2026-03-31",
      source: "5.5, pages 20-21 (NSW); 5.7, page 24 (CAE, EDW); 5.8, page 25 (ND)",
      value: { ND: "45", NSW: "10.5", CAE: "17.5", EDW: "17.5" },
    },
  ],
  studentLoan: [
    {
      from: "2025-04-01",
      to: "2026-03-31",
      source: "2.2, page 6; 5.4, page 19",
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
      from: "2025-04-01",
      to: "2026-03-31",
      source: "4 and 4.1, page 10",
      value: {
        employeeRates: ["3", "4", "6", "8", "10"],
        defaultEmployeeRate: "3",
        minimumEmployerRate: "3",
        temporaryRateReduction: null,
      },
    },
  ],
  esct: [
    {
      from: "2025-04-01",
      to: "2026-03-31",
      source: "2.3, page 7 (from 1 April 2025)",
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
