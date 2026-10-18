export interface client {
    id?: number;
    numberClient: string;
}

export interface ImpresionLog {
    id?: number;
    nameImpresion: string;
    contentImpresion: string;
    dateImpresion: Date;
}

export interface paymentRecorded{
    id?: number;
    impresionId: number;
    clientId?: string;
    referencePayment: string;
    amount: number;
    sincronizedExcel: boolean;
    createdAt: Date;
}