/*
 * VMU (Sanyo LC86K87) emulator core in JavaScript.
 *
 * A close port of the emulator core of DreamPotato by Rikki Gibson
 * (https://github.com/RikkiGibson/DreamPotato), MIT License:
 *
 *   Copyright (c) 2025 Rikki Gibson
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify,
 *   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to the following
 *   conditions: The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Works in browsers and in Node (module.exports) for testing.
 */
(function (root) {
  "use strict";

  const TICKS_PER_SECOND = 10000000;         
  const BANK_SIZE = 0x10000;
  const FLASH_SIZE = 0x20000;

  // Oscillators (Hz)
  const OSC_CF = 6000000, OSC_RC = 872000, OSC_QUARTZ = 32768;

  // SFR addresses (offset from 0x100)
  const ACC = 0x00, PSW = 0x01, B = 0x02, C = 0x03, TRL = 0x04, TRH = 0x05, SP = 0x06, PCON = 0x07,
    IE = 0x08, IP = 0x09, EXT = 0x0d, OCR = 0x0e, T0CNT = 0x10, T0PRR = 0x11, T0L = 0x12, T0LR = 0x13,
    T0H = 0x14, T0HR = 0x15, T1CNT = 0x18, T1LC = 0x1a, T1L = 0x1b, T1HC = 0x1c, T1H = 0x1d,
    MCR = 0x20, CNR = 0x23, TDR = 0x24, XBNK = 0x25, VCCR = 0x27, SCON0 = 0x30, SBUF0 = 0x31, SBR = 0x32,
    SCON1 = 0x34, SBUF1 = 0x35, P1 = 0x44, P1DDR = 0x45, P1FCR = 0x46, P3 = 0x4c, P3DDR = 0x4d, P3INT = 0x4e,
    FPR = 0x54, P7 = 0x5c, I01CR = 0x5d, I23CR = 0x5e, ISL = 0x5f, VSEL = 0x63, VRMAD1 = 0x64,
    VRMAD2 = 0x65, VTRBF = 0x66, BTCR = 0x7f;

  // Interrupts (bit flags) and vectors
  const INT_NONE = 0, INT0 = 1, INT1 = 2, INT2_T0L = 4, INT3_BT = 8, INT_T0H = 16, INT_T1 = 32,
    INT_SIO0 = 64, INT_SIO1 = 128, INT_P3 = 512;
  const VECTORS = { 1: 0x03, 2: 0x0b, 4: 0x13, 8: 0x1b, 16: 0x23, 32: 0x2b, 64: 0x33, 128: 0x3b, 256: 0x43, 512: 0x4b };

  // Instruction banks
  const BANK_ROM = 0, BANK_FLASH0 = 1, BANK_FLASH1 = 2;

//Operations
  const OP = {};
  ["ADD", "ADDC", "SUB", "SUBC", "INC", "DEC", "MUL", "DIV", "AND", "OR", "XOR", "ROL", "ROLC", "ROR", "RORC",
    "LD", "ST", "MOV", "LDC", "LDF", "STF", "PUSH", "POP", "XCH", "JMP", "JMPF", "BR", "BRF", "BZ", "BNZ", "BP",
    "BPC", "BN", "DBNZ", "BE", "BNE", "CALL", "CALLF", "CALLR", "RET", "RETI", "CLR1", "SET1", "NOT1", "NOP"]
    .forEach((k, i) => OP[k] = i);

 
  const P_NONE = 0, P_I8 = 1, P_D9 = 2, P_RI = 3;

  // ---- Opcode table
  const TABLE = new Array(256);
  (function buildTable() {
    const set = (b, kind, mode, size, cycles, dec) => { TABLE[b] = [kind, mode, size, cycles, dec]; };
    const arith = (base, kind) => {
      set(base | 1, kind, P_I8, 2, 1, 1);
      set(base | 2, kind, P_D9, 2, 1, 2); set(base | 3, kind, P_D9, 2, 1, 2);
      for (let i = 4; i < 8; i++) set(base | i, kind, P_RI, 1, 1, 3);
    };
    const direct = (base, kind, cycles = 1) => {
      set(base | 2, kind, P_D9, 2, cycles, 2); set(base | 3, kind, P_D9, 2, cycles, 2);
      for (let i = 4; i < 8; i++) set(base | i, kind, P_RI, 1, cycles, 3);
    };
    const bitop = (base, kind, size, cycles, dec) => {
      for (let i = 0; i < 8; i++) { set(base | i, kind, P_D9, size, cycles, dec); set(base | 0x10 | i, kind, P_D9, size, cycles, dec); }
    };
    const a12 = (base, kind) => {
      for (let i = 0; i < 8; i++) { set(base | i, kind, P_NONE, 2, 2, 6); set(base | 0x10 | i, kind, P_NONE, 2, 2, 6); }
    };
    arith(0x80, OP.ADD); arith(0x90, OP.ADDC); arith(0xa0, OP.SUB); arith(0xb0, OP.SUBC);
    arith(0xe0, OP.AND); arith(0xd0, OP.OR); arith(0xf0, OP.XOR);
    direct(0x60, OP.INC); direct(0x70, OP.DEC); direct(0x00, OP.LD); direct(0x10, OP.ST); direct(0xc0, OP.XCH);
    set(0x30, OP.MUL, P_NONE, 1, 7, 0); set(0x40, OP.DIV, P_NONE, 1, 7, 0);
    set(0xe0, OP.ROL, P_NONE, 1, 1, 0); set(0xf0, OP.ROLC, P_NONE, 1, 1, 0);
    set(0xc0, OP.ROR, P_NONE, 1, 1, 0); set(0xd0, OP.RORC, P_NONE, 1, 1, 0);

    set(0x22, OP.MOV, P_D9, 3, 2, 4); set(0x23, OP.MOV, P_D9, 3, 2, 4);
    for (let i = 4; i < 8; i++) set(0x20 | i, OP.MOV, P_RI, 2, 1, 5);
    set(0xc1, OP.LDC, P_NONE, 1, 2, 0); set(0x50, OP.LDF, P_NONE, 1, 2, 0); set(0x51, OP.STF, P_NONE, 1, 2, 0);
    set(0x60, OP.PUSH, P_D9, 2, 2, 2); set(0x61, OP.PUSH, P_D9, 2, 2, 2);
    set(0x70, OP.POP, P_D9, 2, 2, 2); set(0x71, OP.POP, P_D9, 2, 2, 2);
    a12(0x28, OP.JMP); a12(0x08, OP.CALL);
    set(0x21, OP.JMPF, P_NONE, 3, 2, 7); set(0x20, OP.CALLF, P_NONE, 3, 2, 7);
    set(0x01, OP.BR, P_NONE, 2, 2, 8); set(0x11, OP.BRF, P_NONE, 3, 4, 9);
    set(0x10, OP.CALLR, P_NONE, 3, 4, 9);
    set(0x80, OP.BZ, P_NONE, 2, 2, 8); set(0x90, OP.BNZ, P_NONE, 2, 2, 8);
    bitop(0x68, OP.BP, 3, 2, 10); bitop(0x48, OP.BPC, 3, 2, 10); bitop(0x88, OP.BN, 3, 2, 10);
    set(0x52, OP.DBNZ, P_D9, 3, 2, 11); set(0x53, OP.DBNZ, P_D9, 3, 2, 11);
    for (let i = 4; i < 8; i++) set(0x50 | i, OP.DBNZ, P_RI, 2, 2, 12);
    set(0x31, OP.BE, P_I8, 3, 2, 13); set(0x32, OP.BE, P_D9, 3, 2, 11); set(0x33, OP.BE, P_D9, 3, 2, 11);
    for (let i = 4; i < 8; i++) set(0x30 | i, OP.BE, P_RI, 3, 2, 14);
    set(0x41, OP.BNE, P_I8, 3, 2, 13); set(0x42, OP.BNE, P_D9, 3, 2, 11); set(0x43, OP.BNE, P_D9, 3, 2, 11);
    for (let i = 4; i < 8; i++) set(0x40 | i, OP.BNE, P_RI, 3, 2, 14);
    set(0xa0, OP.RET, P_NONE, 1, 2, 0); set(0xb0, OP.RETI, P_NONE, 1, 2, 0);
    bitop(0xc8, OP.CLR1, 2, 1, 15); bitop(0xe8, OP.SET1, 2, 1, 15); bitop(0xa8, OP.NOT1, 2, 1, 15);
    set(0x00, OP.NOP, P_NONE, 1, 1, 0);
    for (let i = 0; i < 256; i++) if (!TABLE[i]) throw new Error("opcode table gap at " + i.toString(16));
  })();

  const s8 = v => (v & 0x80) ? v - 0x100 : v;
  const bcd = v => (((v / 10) | 0) << 4) | (v % 10);

  class VmuCore {
    constructor() {
      this.rom = new Uint8Array(BANK_SIZE);
      this.flash = new Uint8Array(FLASH_SIZE);
      this.mainRam0 = new Uint8Array(0x100);
      this.mainRam1 = new Uint8Array(0x100);
      this.sfr = new Uint8Array(0x80);
      this.xram0 = new Uint8Array(0x80);
      this.xram1 = new Uint8Array(0x80);
      this.xram2 = new Uint8Array(6);
      this.workRam = new Uint8Array(0x200);
      this.t1hr = 0; this.t1lr = 0;
      this.servicing = [0, 0, 0];
      this.audioCompare = 0;
      this.onFlashWrite = null;  
      this.onSample = null;       
      this.reset();
    }

  
    reset() {
      this.pc = 0;
      this.ticksOverrun = 0;
      this.stepRemainder = 0;
      this.baseTimer = 0;
      this.baseTimerTicksRemaining = 0;
      this.t0Scale = 0;
      this.serialBitCount = 0;
      this.serialTransferTimer = 0;
      this.servicing.fill(0);
      this.intCount = 0;
      this.intNotReady = false;
      this.flashSeq = 0;
      this.mainRam0.fill(0); this.mainRam1.fill(0);
      this.resetSfrs();
      this.xram0.fill(0); this.xram1.fill(0); this.xram2.fill(0);
      this.workRam.fill(0);
      this.bank = this.extBank();
    }

    resetSfrs() {
      const oldP7 = this.sfr[P7];
      this.sfr.fill(0);
      this.sfrWrite(IE, 0x80);
      this.sfrWrite(EXT, 0x08);                    
      this.sfrWrite(P1FCR, 0xbf);
      this.sfrWrite(P3INT, 0xfd);
      this.sfrWrite(P3, 0xff);
      this.sfrWrite(P7, 0x02 | (oldP7 & 0x0d));    
      this.sfrWrite(ISL, 0xc0);
      this.sfrWrite(VSEL, 0xfc);
      this.sfrWrite(BTCR, 0x41);
      this.sfrWrite(VCCR, 0x80);
      this.sfrWrite(SP, 0x7f);
    }

    /** Skip the BIOS date-entry screen, like DreamPotato's AutoInitializeDate. Call right after reset(). */
    initializeDate(date) {
      this.pc = 0x2e1;                            
      const r = this.mainRam0, y = date.getFullYear();
      r[0x10] = bcd(((y / 100) | 0) % 100); r[0x11] = bcd(y % 100);
      r[0x12] = bcd(date.getMonth() + 1); r[0x13] = bcd(date.getDate());
      r[0x14] = bcd(date.getHours()); r[0x15] = bcd(date.getMinutes()); r[0x16] = bcd(date.getSeconds());
      r[0x17] = (y >> 8) & 0xff; r[0x18] = y & 0xff;
      r[0x19] = date.getMonth() + 1; r[0x1a] = date.getDate(); r[0x1b] = date.getHours();
      r[0x1c] = date.getMinutes(); r[0x1d] = date.getSeconds();
      r[0x1e] = date.getMilliseconds() >= 500 ? 1 : 0;
      r[0x1f] = ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 1 : 0;
      r[0xff] = 0xff;
      this.sfrWrite(IE, 0x83);
      this.sfrWrite(IP, 0x02);
      this.sfrWrite(OCR, 0xa3);
      this.sfrWrite(T1LC, 0xff);
      this.sfr[T1L] = 0xff;
      this.sfrWrite(MCR, 0x09);
      this.sfrWrite(CNR, 0x05);
      this.sfrWrite(TDR, 0x20);
      this.sfrWrite(P1, 0xc0);
      this.sfrWrite(P1DDR, 0xc0);
      this.sfrWrite(P3INT, 0x05);
      this.sfrWrite(0x51, 0x20);
      this.sfrWrite(FPR, 0x00);
      this.sfrWrite(0x55, 0xff);
      this.sfrWrite(VSEL, 0x10);
      this.sfrWrite(BTCR, 0x79);
    }


    extBank() {
      const ext = this.sfr[EXT];
      if (ext & 1) return BANK_FLASH0;
      return (ext & 8) ? BANK_ROM : BANK_FLASH1;
    }

    sfrRead(a, sideEffects = true) {
      if (a === VTRBF) {
        let addr = ((this.sfr[VRMAD2] & 1) ? 0x100 : 0) | this.sfr[VRMAD1];
        const v = this.workRam[addr];
        if (sideEffects && (this.sfr[VSEL] & 0x10)) {
          addr++;
          this.sfrWrite(VRMAD1, addr & 0xff);
          this.sfrWrite(VRMAD2, (addr & 0x100) ? 1 : 0);
        }
        return v;
      }
      return this.sfr[a];
    }

    sfrWrite(a, v) {
      v &= 0xff;
      const raw = this.sfr;
      switch (a) {
        case VTRBF: {
          let addr = ((raw[VRMAD2] & 1) ? 0x100 : 0) | raw[VRMAD1];
          this.workRam[addr] = v;
          if (raw[VSEL] & 0x10) {
            addr++;
            this.sfrWrite(VRMAD1, addr & 0xff);
            this.sfrWrite(VRMAD2, (addr & 0x100) ? 1 : 0);
          }
          return;
        }
        case T1L:
          this.t1lr = v;
          if (!(raw[T1CNT] & 0x40)) raw[T1L] = v;
          return;
        case T1H:
          this.t1hr = v;
          if (!(raw[T1CNT] & 0x80)) raw[T1H] = v;
          return;
        case BTCR:
          if (!(v & 0x40)) this.baseTimer = 0;
          break;
        case PCON: case IP: case IE:
          this.intNotReady = true;
          break;
        case T0CNT: {
          const old = raw[T0CNT];
          if (!(old & 0x40) && !(old & 0x80) && ((v & 0x40) || (v & 0x80))) this.t0Scale = raw[T0PRR];
          if ((old & 0x40) !== (v & 0x40)) raw[T0L] = raw[T0LR];
          if ((old & 0x80) !== (v & 0x80)) raw[T0H] = raw[T0HR];
          break;
        }
        case T1CNT: {
          const old = raw[T1CNT];
          if ((old & 0x40) !== (v & 0x40)) {
            raw[T1L] = this.t1lr;
            this.audioCompare = raw[T1LC];              
          }
          if ((old & 0x80) !== (v & 0x80)) raw[T1H] = this.t1hr;
          break;
        }
        case SBR:
          this.serialTransferTimer = v;
          break;
      }
      raw[a] = v;
    }


    read(address) {
      if (address < 0x100) return ((this.sfr[PSW] & 2) ? this.mainRam1 : this.mainRam0)[address];
      if (address < 0x180) return this.sfrRead(address - 0x100);
      if (address < 0x200) return this.readXram(address - 0x180);
      return 0xff;
    }

    write(address, v) {
      v &= 0xff;
      if (address < 0x100) { ((this.sfr[PSW] & 2) ? this.mainRam1 : this.mainRam0)[address] = v; return; }
      if (address < 0x180) { this.sfrWrite(address - 0x100, v); return; }
      if (address < 0x200) this.writeXram(address - 0x180, v);
    }

    readXram(a) {
      const xb = this.sfr[XBNK];
      if (xb === 0 || xb === 1) {
        if ((a & 0xf) >= 0xc) return 0xff;
        return (xb === 0 ? this.xram0 : this.xram1)[a];
      }
      if (xb === 2) return a < 6 ? this.xram2[a] : 0xff;
      return 0xff;
    }

    writeXram(a, v) {
      const xb = this.sfr[XBNK];
      if (xb === 0 || xb === 1) {
        if ((a & 0xf) >= 0xc) return;
        (xb === 0 ? this.xram0 : this.xram1)[a] = v;
      } else if (xb === 2) {
        if (a <= 5) this.xram2[a] = v;
      }
    }

    pushStack(v) {
      const sp = (this.sfr[SP] + 1) & 0xff;
      this.sfrWrite(SP, sp);
      this.mainRam0[sp] = v & 0xff;
    }

    popStack() {
      const sp = this.sfr[SP];
      const v = this.mainRam0[sp];
      this.sfrWrite(SP, (sp - 1) & 0xff);
      return v;
    }

    indirectAddress(reg) {
      const irbk = this.sfr[PSW] & 0x18;
      const regAddr = (irbk >> 1) | reg;
      return ((reg & 2) ? 0x100 : 0) | this.read(regAddr);
    }

    get acc() { return this.sfr[ACC]; }
    set acc(v) { this.sfrWrite(ACC, v); }
    get psw() { return this.sfr[PSW]; }
    set psw(v) { this.sfrWrite(PSW, v); }


    cpuClockHz() {
      const ocr = this.sfr[OCR];
      const divisor = (ocr & 0x80) ? 6 : 12;
      let osc;
      if (ocr & 0x10) osc = OSC_CF;
      else if (ocr & 0x20) osc = OSC_QUARTZ;
      else osc = OSC_RC;
      return Math.floor(osc / divisor);
    }

    get docked() { return (this.sfr[P7] & 1) !== 0; }

    /** Run for the given number of 100ns ticks of emulated time. */
    run(ticksToRun) {
      if (this.docked) return ticksToRun;
      ticksToRun -= this.ticksOverrun;
      let soFar = 0;
      while (soFar < ticksToRun) soFar += this.stepTicks();
      this.ticksOverrun = soFar - ticksToRun;
      return soFar;
    }

    stepTicks() {
      const hz = this.cpuClockHz();
      const cycles = this.step();
      const cyclesTicks = cycles * TICKS_PER_SECOND + this.stepRemainder;
      const elapsed = Math.floor(cyclesTicks / hz);
      this.stepRemainder = cyclesTicks % hz;

      // base timer
      let btcr = this.sfr[BTCR];
      const isl = this.sfr[ISL];
      const sel = (isl >> 4) & 3;                    
      const btHz = sel === 1 ? hz : OSC_QUARTZ;      
      this.baseTimerTicksRemaining += elapsed;
      const ticksPerCycle = Math.floor(TICKS_PER_SECOND / btHz);
      const btElapsed = Math.floor(this.baseTimerTicksRemaining / ticksPerCycle);
      this.baseTimerTicksRemaining %= ticksPerCycle;
      const cur = this.baseTimer;
      const next = (cur + btElapsed) & 0xffff;
      const int1Rate = btInt1Rate(btcr);
      if (Math.floor(cur / int1Rate) < Math.floor(next / int1Rate)) btcr |= 0x08;
      const int0Rate = (btcr & 0x80) ? 0x40 : 0x4000;
      if (Math.floor(cur / int0Rate) < Math.floor(next / int0Rate)) btcr |= 0x02;
      this.baseTimer = next % 0x4000;
      this.sfrWrite(BTCR, btcr);
      return elapsed;
    }

    checkForInterrupt() {
      const s = this.sfr, ie = s[IE], i01 = s[I01CR];
      const pc1 = ie & 2, pc0 = ie & 1;
      if (!pc0 && (i01 & 0x01) && (i01 & 0x02)) return INT0;          
      if (!pc1 && !pc0 && (i01 & 0x10) && (i01 & 0x20)) return INT1;  
      if (!(ie & 0x80)) return INT_NONE;
      let found = this.checkOneInterrupt(true);
      if (found === INT_NONE) found = this.checkOneInterrupt(false);
      return found;
    }

    checkOneInterrupt(highOnly) {
      const s = this.sfr, ip = s[IP];
      const t0 = s[T0CNT], i23 = s[I23CR], bt = s[BTCR], t1 = s[T1CNT];
      if ((!highOnly || (ip & 0x01)) && (((t0 & 0x01) && (t0 & 0x02)) || ((i23 & 0x01) && (i23 & 0x02)))) return INT2_T0L;
      if ((!highOnly || (ip & 0x02)) && (((bt & 0x01) && (bt & 0x02)) || ((bt & 0x04) && (bt & 0x08)))) return INT3_BT;
      if ((!highOnly || (ip & 0x04)) && (t0 & 0x04) && (t0 & 0x08)) return INT_T0H;
      if ((!highOnly || (ip & 0x08)) && (((t1 & 0x01) && (t1 & 0x02)) || ((t1 & 0x04) && (t1 & 0x08)))) return INT_T1;
      if ((!highOnly || (ip & 0x10)) && (s[SCON0] & 0x01) && (s[SCON0] & 0x02)) return INT_SIO0;
      if ((!highOnly || (ip & 0x20)) && (s[SCON1] & 0x01) && (s[SCON1] & 0x02)) return INT_SIO1;
      if ((!highOnly || (ip & 0x80)) && (s[P3INT] & 0x01) && (s[P3INT] & 0x02)) return INT_P3;
      return INT_NONE;
    }

    serviceInterrupt(interrupt) {
      if (this.intNotReady) { this.intNotReady = false; return false; }
      if (this.intCount >= 1) return false;
      if (interrupt === INT_NONE) return false;
      this.servicing[this.intCount++] = interrupt;
      this.sfrWrite(PCON, this.sfr[PCON] & ~1);      
      const pc = this.pc;
      this.pushStack(pc & 0xff);
      this.pushStack(pc >> 8);
      this.pc = VECTORS[interrupt];
      return true;
    }

    requestLevelDrivenInterrupts() {
      let i01 = this.sfr[I01CR];
      const p7 = this.sfr[P7];
      if ((i01 & 0x01) && (i01 & 0x04) && ((p7 & 1) !== 0) === ((i01 & 0x08) !== 0)) {
        i01 |= 0x02; this.sfrWrite(I01CR, i01);
      }
      if ((i01 & 0x10) && (i01 & 0x40) && ((p7 & 2) !== 0) === ((i01 & 0x80) !== 0)) {
        i01 |= 0x20; this.sfrWrite(I01CR, i01);
      }
      const p3int = this.sfr[P3INT];
      if ((p3int & 1) && (p3int & 4) && this.sfr[P3] !== 0xff) this.sfrWrite(P3INT, p3int | 2);
    }

    handleInterrupts(interrupt) {
      this.requestLevelDrivenInterrupts();
      return this.serviceInterrupt(interrupt);
    }

    tickTimers(cycles) {
      const s = this.sfr;

      let t0cnt = s[T0CNT];
      if (t0cnt & 0xc0) {
        let t0Ticks = 0;
        for (let i = 0; i < cycles; i++) {
          this.t0Scale = (this.t0Scale + 1) & 0xff;
          if (this.t0Scale === 0) { t0Ticks++; this.t0Scale = s[T0PRR]; }
        }
        let t0l = s[T0L], t0h = s[T0H];
        for (let i = 0; i < t0Ticks; i++) {
          let lOverflow = false;
          if (t0cnt & 0x40) {
            t0l = (t0l + 1) & 0xff;
            if (t0l === 0) {
              lOverflow = true;
              t0l = s[T0LR];
              if (!(t0cnt & 0x20)) t0cnt |= 0x02;
            }
          }
          if (t0cnt & 0x80) {
            if (!(t0cnt & 0x20) || lOverflow) t0h = (t0h + 1) & 0xff;
            if (t0h === 0) { t0h = s[T0HR]; t0cnt |= 0x08; }
          }
        }
        this.sfrWrite(T0L, t0l);
        this.sfrWrite(T0H, t0h);
        this.sfrWrite(T0CNT, t0cnt);
      }


      let t1cnt = s[T1CNT];
      const doubleSpeed = (t1cnt & 0xe0) === 0x60;     
      const nTicks = doubleSpeed ? cycles * 2 : cycles;
      const tickHz = doubleSpeed ? this.cpuClockHz() * 2 : this.cpuClockHz();
      const lRun = (t1cnt & 0x40) !== 0;
      for (let i = 0; i < nTicks; i++) {
        let t1l = s[T1L];
        const pulse = t1l >= this.audioCompare;
        this.sfrWrite(P1, pulse ? (s[P1] | 0x80) : (s[P1] & 0x7f));
        if (this.onSample) this.onSample(lRun ? (pulse ? 1 : -1) : 0, tickHz);
        if (lRun) {
          t1l = (t1l + 1) & 0xff;
          if (t1l === 0) {
            t1l = this.t1lr;
            if (t1cnt & 0x10) this.audioCompare = s[T1LC];   // ELDT1C
            t1cnt |= 0x02;
          }
          s[T1L] = t1l;
        }
        if (t1cnt & 0x80) {
          if (!(t1cnt & 0x20) || (t1cnt & 0x02)) {
            let t1h = (s[T1H] + 1) & 0xff;
            if (t1h === 0) { t1h = this.t1hr; t1cnt |= 0x08; }
            s[T1H] = t1h;
          }
        }
      }
      this.sfrWrite(T1CNT, t1cnt);

    }

    
    /** Execute one instruction (or one halt cycle). Returns CPU cycles consumed. */
    step() {
      const interrupt = this.checkForInterrupt();

      if (this.sfr[PCON] & 1) {                      
        this.tickTimers(1);
        if (this.handleInterrupts(interrupt)) { this.tickTimers(2); return 3; }
        return 1;
      }

      const code = this.bank === BANK_ROM ? this.rom : this.flash;
      const base = this.bank === BANK_FLASH1 ? BANK_SIZE : 0;
      const pc = this.pc;
      const b0 = code[base + pc];
      const b1 = code[base + ((pc + 1) & 0xffff)];
      const b2 = code[base + ((pc + 2) & 0xffff)];
      const [kind, mode, size, cycles, dec] = TABLE[b0];

      let a0 = 0, a1 = 0, a2 = 0;
      switch (dec) {
        case 1: case 8: a0 = b1; break;
        case 2: a0 = ((b0 & 1) << 8) | b1; break;
        case 3: a0 = b0 & 3; break;
        case 4: a0 = b2; a1 = ((b0 & 1) << 8) | b1; break;
        case 5: a0 = b1; a1 = b0 & 3; break;
        case 6: a0 = ((((b0 & 0x10) >> 1) | (b0 & 7)) << 8) | b1; break;
        case 7: a0 = (b1 << 8) | b2; break;
        case 9: a0 = b1 | (b2 << 8); break;
        case 10: a0 = ((b0 & 0x10) << 4) | b1; a1 = b0 & 7; a2 = b2; break;
        case 11: a0 = ((b0 & 1) << 8) | b1; a1 = b2; break;
        case 12: a0 = b0 & 3; a1 = b1; break;
        case 13: a0 = b1; a1 = b2; break;
        case 14: a0 = b0 & 3; a1 = b1; a2 = b2; break;
        case 15: a0 = ((b0 & 0x10) << 4) | b1; a1 = b0 & 7; break;
      }

      // DreamPotato workaround for the BIOS file-transfer routine.
      if (this.bank === BANK_ROM && pc === 0x2515 && kind === OP.DEC && mode === P_D9 && a0 === 1) {
        this.pc = (pc + size) & 0xffff;
        this.tickTimers(cycles);
        let c = cycles;
        if (this.handleInterrupts(interrupt)) { this.tickTimers(2); c += 2; }
        return c;
      }

      this.tickTimers(cycles);
      this.execute(kind, mode, size, a0, a1, a2);

      if (this.handleInterrupts(interrupt)) { this.tickTimers(2); return cycles + 2; }
      return cycles;
    }

    fetch(mode, arg) {
      if (mode === P_I8) return arg & 0xff;
      if (mode === P_D9) return this.read(arg);
      return this.read(this.indirectAddress(arg));     // P_RI
    }

    addr(mode, arg) {
      return mode === P_D9 ? arg : this.indirectAddress(arg);
    }

    execute(kind, mode, size, a0, a1, a2) {
      const next = (this.pc + size) & 0xffff;
      switch (kind) {
        case OP.ADD: {
          const rhs = this.fetch(mode, a0), lhs = this.acc, res = (lhs + rhs) & 0xff;
          this.acc = res;
          let psw = this.psw & ~(0x80 | 0x40 | 0x04);
          if (res < lhs) psw |= 0x80;
          if ((lhs & 0xf) + (rhs & 0xf) > 0xf) psw |= 0x40;
          if (((lhs & rhs & ~res) | (~lhs & ~rhs & res)) & 0x80) psw |= 0x04;
          this.psw = psw; this.pc = next; return;
        }
        case OP.ADDC: {
          const rhs = this.fetch(mode, a0), lhs = this.acc;
          const carry = (this.psw & 0x80) ? 1 : 0;
          const res = (lhs + carry + rhs) & 0xff;
          this.acc = res;
          let psw = this.psw & ~(0x80 | 0x40 | 0x04);
          if (res < lhs) psw |= 0x80;
          if ((lhs & 0xf) + carry + (rhs & 0xf) > 0xf) psw |= 0x40;
          const l2 = (lhs + carry) & 0xff;
          if (((l2 & rhs & ~res) | (~l2 & ~rhs & res)) & 0x80) psw |= 0x04;
          this.psw = psw; this.pc = next; return;
        }
        case OP.SUB: {
          const rhs = this.fetch(mode, a0), lhs = this.acc, res = (lhs - rhs) & 0xff;
          this.acc = res;
          let psw = this.psw & ~(0x80 | 0x40 | 0x04);
          if (lhs < rhs) psw |= 0x80;
          if ((lhs & 0xf) < (rhs & 0xf)) psw |= 0x40;
          if (((lhs & ~rhs & ~res) | (~lhs & rhs & res)) & 0x80) psw |= 0x04;
          this.psw = psw; this.pc = next; return;
        }
        case OP.SUBC: {
          const rhs = this.fetch(mode, a0), lhs = this.acc;
          const carry = (this.psw & 0x80) ? 1 : 0;
          const res = (lhs - carry - rhs) & 0xff;
          this.acc = res;
          let psw = this.psw & ~(0x80 | 0x40 | 0x04);
          if (lhs - carry - rhs < 0) psw |= 0x80;
          if ((lhs & 0xf) - carry - (rhs & 0xf) < 0) psw |= 0x40;
          const l2 = (lhs + carry) & 0xff;
          if (((l2 & ~rhs & ~res) | (~l2 & rhs & res)) & 0x80) psw |= 0x04;
          this.psw = psw; this.pc = next; return;
        }
        case OP.INC: { const ad = this.addr(mode, a0); this.write(ad, this.read(ad) + 1); this.pc = next; return; }
        case OP.DEC: { const ad = this.addr(mode, a0); this.write(ad, this.read(ad) - 1); this.pc = next; return; }
        case OP.MUL: {
          const r = ((this.acc << 8) | this.sfr[C]) * this.sfr[B];
          this.sfrWrite(B, r >> 16); this.acc = r >> 8; this.sfrWrite(C, r);
          let psw = this.psw & ~0x84;
          if (this.sfr[B] !== 0) psw |= 0x04;
          this.psw = psw; this.pc = next; return;
        }
        case OP.DIV: {
          let psw = this.psw;
          if (this.sfr[B] === 0) { this.acc = 0xff; psw |= 0x04; }
          else {
            const lhs = (this.acc << 8) | this.sfr[C], b = this.sfr[B];
            const q = Math.floor(lhs / b), m = lhs % b;
            this.acc = q >> 8; this.sfrWrite(C, q); this.sfrWrite(B, m);
            psw &= ~0x04;
          }
          psw &= ~0x80;
          this.psw = psw; this.pc = next; return;
        }
        case OP.AND: this.acc = this.acc & this.fetch(mode, a0); this.pc = next; return;
        case OP.OR: this.acc = this.acc | this.fetch(mode, a0); this.pc = next; return;
        case OP.XOR: this.acc = this.acc ^ this.fetch(mode, a0); this.pc = next; return;
        case OP.ROL: { const v = this.acc << 1; this.acc = v | ((v & 0x100) ? 1 : 0); this.pc = next; return; }
        case OP.ROLC: {
          const v = (this.acc << 1) | ((this.psw & 0x80) ? 1 : 0);
          const psw = (v & 0x100) ? (this.psw | 0x80) : (this.psw & ~0x80);
          this.acc = v; this.psw = psw; this.pc = next; return;
        }
        case OP.ROR: { const a = this.acc; this.acc = (a >> 1) | ((a & 1) ? 0x80 : 0); this.pc = next; return; }
        case OP.RORC: {
          const a = this.acc, cy = a & 1, psw = this.psw;
          this.acc = ((psw & 0x80) ? 0x80 : 0) | (a >> 1);
          this.psw = cy ? (psw | 0x80) : (psw & ~0x80); this.pc = next; return;
        }
        case OP.LD: this.acc = this.fetch(mode, a0); this.pc = next; return;
        case OP.ST: this.write(this.addr(mode, a0), this.acc); this.pc = next; return;
        case OP.MOV: this.write(this.addr(mode, a1), a0); this.pc = next; return;
        case OP.LDC: {
          const ad = (((this.sfr[TRH] << 8) | this.sfr[TRL]) + this.acc) & 0xffff;
          const code = this.bank === BANK_ROM ? this.rom : this.flash;
          this.acc = code[(this.bank === BANK_FLASH1 ? BANK_SIZE : 0) + ad];
          this.pc = next; return;
        }
        case OP.PUSH: this.pushStack(this.read(a0)); this.pc = next; return;
        case OP.POP: { const v = this.popStack(); this.write(a0, v); this.pc = next; return; }
        case OP.XCH: {
          const ad = this.addr(mode, a0), newAcc = this.read(ad);
          this.write(ad, this.acc); this.acc = newAcc; this.pc = next; return;
        }
        case OP.JMP: this.pc = (((this.pc + 2) & 0xf000) | a0) & 0xffff; return;
        case OP.JMPF: this.pc = a0; this.bank = this.extBank(); return;
        case OP.BR: this.pc = (this.pc + size + s8(a0)) & 0xffff; return;
        case OP.BRF: this.pc = (this.pc + size - 1 + a0) & 0xffff; return;
        case OP.BZ: this.pc = this.acc === 0 ? (next + s8(a0)) & 0xffff : next; return;
        case OP.BNZ: this.pc = this.acc !== 0 ? (next + s8(a0)) & 0xffff : next; return;
        case OP.BP: this.pc = (this.read(a0) & (1 << a1)) ? (next + s8(a2)) & 0xffff : next; return;
        case OP.BN: this.pc = !(this.read(a0) & (1 << a1)) ? (next + s8(a2)) & 0xffff : next; return;
        case OP.BPC: {
          const v = this.read(a0), nv = v & ~(1 << a1);
          this.pc = v !== nv ? (next + s8(a2)) & 0xffff : next;
          this.write(a0, nv); return;
        }
        case OP.DBNZ: {
          const ad = this.addr(mode, a0), v = (this.read(ad) - 1) & 0xff;
          this.write(ad, v);
          this.pc = v !== 0 ? (next + s8(a1)) & 0xffff : next; return;
        }
        case OP.BE: case OP.BNE: {
          let lhs, rhs, r8;
          if (mode === P_RI) { lhs = this.read(this.indirectAddress(a0)); rhs = a1; r8 = a2; }
          else { lhs = this.acc; rhs = this.fetch(mode, a0); r8 = a1; }
          this.psw = lhs < rhs ? (this.psw | 0x80) : (this.psw & ~0x80);
          const take = kind === OP.BE ? lhs === rhs : lhs !== rhs;
          this.pc = take ? (next + s8(r8)) & 0xffff : next; return;
        }
        case OP.CALL: {
          this.pushStack(next & 0xff); this.pushStack(next >> 8);
          this.pc = (next & 0xf000) | a0; return;
        }
        case OP.CALLF: {
          this.pushStack(next & 0xff); this.pushStack(next >> 8);
          this.pc = a0; return;
        }
        case OP.CALLR: {
          this.pushStack(next & 0xff); this.pushStack(next >> 8);
          this.pc = (next - 1 + a0) & 0xffff; return;
        }
        case OP.RET: { const hi = this.popStack(), lo = this.popStack(); this.pc = (hi << 8) | lo; return; }
        case OP.RETI: {
          this.intNotReady = true;
          if (this.intCount > 0) { this.intCount--; this.servicing[this.intCount] = 0; }
          const hi = this.popStack(), lo = this.popStack(); this.pc = (hi << 8) | lo; return;
        }
        case OP.CLR1: this.write(a0, this.read(a0) & ~(1 << a1)); this.pc = next; return;
        case OP.SET1: this.write(a0, this.read(a0) | (1 << a1)); this.pc = next; return;
        case OP.NOT1: this.write(a0, this.read(a0) ^ (1 << a1)); this.pc = next; return;
        case OP.LDF: {
          const a17 = this.sfr[TRL] | (this.sfr[TRH] << 8) | ((this.sfr[FPR] & 1) ? BANK_SIZE : 0);
          this.acc = this.flash[a17]; this.pc = next; return;
        }
        case OP.STF: { this.storeFlash(); this.pc = next; return; }
        case OP.NOP: this.pc = next; return;
      }
    }

    storeFlash() {
      const a16 = this.sfr[TRL] | (this.sfr[TRH] << 8);
      const v = this.acc;
      const fpr = this.sfr[FPR];
      if (fpr & 2) {                                     
        const s = this.flashSeq;
        if (s === 0 && a16 === 0x5555 && v === 0xaa) this.flashSeq = 1;
        else if (s === 1 && a16 === 0x2aaa && v === 0x55) this.flashSeq = 2;
        else if (s === 2 && a16 === 0x5555 && v === 0xa0) this.flashSeq = 3;
        else this.flashSeq = 0;
        return;
      }
      if (this.flashSeq >= 3) {
        const a17 = a16 | ((fpr & 1) ? BANK_SIZE : 0);
        this.flash[a17] = v;
        if (this.onFlashWrite) this.onFlashWrite(a17);
        this.flashSeq++;
      }
      if (this.flashSeq === 3 + 128) this.flashSeq = 0;
    }


    /** Buttons: object with up/down/left/right/a/b/mode/sleep booleans (true = pressed). */
    setButtons(btn) {
      let v = 0xff;
      if (btn.up) v &= ~0x01; if (btn.down) v &= ~0x02; if (btn.left) v &= ~0x04; if (btn.right) v &= ~0x08;
      if (btn.a) v &= ~0x10; if (btn.b) v &= ~0x20; if (btn.mode) v &= ~0x40; if (btn.sleep) v &= ~0x80;
      // Any button wakes the VMU from sleep (DreamPotato default)
      if (!(this.sfr[VCCR] & 0x80) && v !== 0xff) v &= ~0x80;
      const p3int = this.sfr[P3INT];
      if (p3int & 1) {
        const old = this.sfr[P3];
        let n = p3int;
        if (!(p3int & 4) && (old & v) !== old) n |= 2;
        this.sfrWrite(P3INT, n);
      }
      this.sfrWrite(P3, v);
    }

    /**
     * Dock (true) or eject (false). When docking, runs one emulated second so the BIOS
     * settles into its docked state (same as DreamPotato). Flash sync is the caller's job.
     */
    connectDreamcast(connect) {
      const oldP7 = this.sfr[P7];
      const was = (oldP7 & 1) !== 0;
      this.sfrWrite(P7, connect ? (oldP7 | 1) : (oldP7 & ~1));
      if (connect && !was) {
        for (let t = 0; t < TICKS_PER_SECOND;) t += this.stepTicks();
      }
      let i01 = this.sfr[I01CR];
      const level = (i01 & 0x04) !== 0, high = (i01 & 0x08) !== 0;
      if (level && high === connect) i01 |= 0x02;
      if (!level && was !== connect && high === connect) i01 |= 0x02;
      this.sfrWrite(I01CR, i01);
    }

    /** 192 bytes, 6 per row, MSB = leftmost pixel, in handheld orientation. */
    getDisplay(out) {
      out = out || new Uint8Array(192);
      if (!(this.sfr[VCCR] & 0x80)) { out.fill(0); return out; }
      let i = 0;
      for (const x of [this.xram0, this.xram1])
        for (let left = 0; left < 0x80; left += 0x10)
          for (let r = 0; r < 0xc; r++) out[i++] = x[left | r];
      return out;
    }

    /** {file, game, clock, flash} LCD icons. */
    getIcons() {
      if (!(this.sfr[VCCR] & 0x80)) return { file: false, game: false, clock: false, flash: false };
      const x = this.xram2;
      return { file: !!(x[1] & 0x40), game: !!(x[2] & 0x10), clock: !!(x[3] & 0x04), flash: !!(x[4] & 0x01) };
    }

    get displayOn() { return (this.sfr[VCCR] & 0x80) !== 0; }

    saveState() {
      const parts = [this.mainRam0, this.mainRam1, this.sfr, this.xram0, this.xram1, this.xram2, this.workRam];
      const regs = [this.t1hr, this.t1lr, this.pc, this.bank, this.ticksOverrun, this.stepRemainder, this.baseTimer,
        this.baseTimerTicksRemaining, this.t0Scale, this.intCount, this.intNotReady ? 1 : 0, this.flashSeq,
        this.audioCompare, ...this.servicing];
      let s = "";
      for (const p of parts) for (let i = 0; i < p.length; i++) s += String.fromCharCode(p[i]);
      return JSON.stringify({ v: 1, mem: btoa(s), regs });
    }

    loadState(json) {
      const st = JSON.parse(json);
      if (st.v !== 1) throw new Error("Bad state. Wrong version??");
      const bin = atob(st.mem);
      let k = 0;
      for (const p of [this.mainRam0, this.mainRam1, this.sfr, this.xram0, this.xram1, this.xram2, this.workRam])
        for (let i = 0; i < p.length; i++) p[i] = bin.charCodeAt(k++);
      const r = st.regs;
      [this.t1hr, this.t1lr, this.pc, this.bank, this.ticksOverrun, this.stepRemainder, this.baseTimer,
        this.baseTimerTicksRemaining, this.t0Scale, this.intCount] = r;
      this.intNotReady = !!r[10]; this.flashSeq = r[11]; this.audioCompare = r[12];
      this.servicing = r.slice(13, 16);
    }
  }

  function btInt1Rate(btcr) {
    const c7 = btcr & 0x80, c5 = btcr & 0x20, c4 = btcr & 0x10;
    if (!c5 && !c4) return 0x20;
    if (!c5 && c4) return 0x80;
    if (!c7 && c5 && !c4) return 0x200;
    if (!c7 && c5 && c4) return 0x800;
    return 0x800;   
  }

  /** A freshly formatted 128 KB VMU image (same layout DreamPotato/BIOS use). */
  function formatFlash(date = new Date()) {
    const f = new Uint8Array(FLASH_SIZE);
    const root = 255 * 512, fat = 254 * 512;
    f.fill(0x55, root, root + 0x10);
    f[root + 0x10] = 1; f[root + 0x11] = 0xff; f[root + 0x12] = 0xff; f[root + 0x13] = 0xff; f[root + 0x14] = 0x64;
    const y = date.getFullYear();
    const ts = [bcd(((y / 100) | 0) % 100), bcd(y % 100), bcd(date.getMonth() + 1), bcd(date.getDate()),
      bcd(date.getHours()), bcd(date.getMinutes()), bcd(date.getSeconds()), date.getDay()];
    f.set(ts, root + 0x30);
    const w16 = (o, v) => { f[o] = v & 0xff; f[o + 1] = v >> 8; };
    w16(root + 0x40, 0xff); w16(root + 0x42, 0); w16(root + 0x44, 255); w16(root + 0x46, 254);
    w16(root + 0x48, 1); w16(root + 0x4a, 253); w16(root + 0x4c, 13);
    w16(root + 0x50, 200); w16(root + 0x52, 41); w16(root + 0x54, 0); w16(root + 0x56, 128);
    for (let i = 0; i < 256; i++) w16(fat + i * 2, 0xfffc);
    w16(fat + 255 * 2, 0xfffa); w16(fat + 254 * 2, 0xfffa);
    for (let i = 253; i > 241; i--) w16(fat + i * 2, i - 1);
    w16(fat + 241 * 2, 0xfffa);
    return f;
  }

  const api = { VmuCore, formatFlash, TICKS_PER_SECOND };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VmuEmu = api;
})(typeof self !== "undefined" ? self : this);
