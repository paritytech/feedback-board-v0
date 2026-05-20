export interface FeedbackData {
    content: string;
    authorName: string;
    postedAt: number;
}

export interface FeedbackListItem {
    id: number;
    cid: string;
    creator: string;
    data?: FeedbackData;
}
